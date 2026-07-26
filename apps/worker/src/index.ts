/**
 * Worker app entrypoint (www-xjba). No HTTP , this is its own deployable package
 * (@control-center/worker) and its own image (control-center-worker), running the
 * continuous reconcile/ingest loops the api used to start in-process. Splitting
 * it out of api keeps the api request-only and lets the loops build, ship,
 * scale, and restart on their own image (www-7d5b.1.2 promoted to a real app).
 *
 * The domain cycles (enforce lights/climate, sync fans, party, ingest weather)
 * still live in @control-center/api and are imported via its ./worker barrel; this package
 * owns only the worker framework (runtime/types) and the worker list below ,
 * which capability runs on what cadence. The eventual packages/core extraction
 * will dissolve the api dependency; until then this is the seam.
 */
import "./boot-env";
import {
  type JobSpec,
  jobWorker,
  reconcilePartyMode,
  releaseInFlightJobsWithTimeout,
  runAscVersionPollCycle,
  runClimateEnforcerCycle,
  runDeviceSyncCycle,
  runEnforcerCycle,
  runGithubPollCycle,
  runMigrations,
  runWeightIngestCycle,
  runWithingsWeightIngestCycle,
  runYoutubeIngest,
  staleJobReaper,
} from "@control-center/api/worker";
import { GENERATED_JOBS } from "@features/_generated/jobs.gen";
import { runSonosVolumeEnforcerCycle } from "@features/sound/enforcer";
import { runPlaylistPollerCycle } from "@features/sound/poller";
import { runWeatherIngestCycle } from "@features/weather/ingest";
import { createLogger, installFatalHandlers } from "@www/logger";
import { ENV as config } from "@www/platform/env";
import { initMetrics, startMetricsServer } from "@www/platform/metrics";
import { createWorkerRuntime, type Worker } from "@www/worker-runtime";
import { hasSufficientDisk } from "./disk-guard";

const log = createLogger({ service: "worker" });

// An escaping async throw or an untracked rejected promise otherwise kills
// this process with zero structured output; see docs/logging.md.
installFatalHandlers(log);

// Prometheus registry + exposition listener (#214). The worker serves no HTTP
// of its own, so this dedicated port is the ONLY listener it has; it fronts no
// Kubernetes Service (Prometheus scrapes the pod IP off the annotations set by
// `WorkloadSpec.scrape`), so it is reachable in-cluster only and never through
// the Cloudflare tunnel. Started before the loops so the very first cycle's
// metrics are already collectable.
initMetrics({ service: "worker" });
startMetricsServer({ port: config.METRICS_PORT, logger: log });

// Apply pending migrations before any cycle touches the DB. The api also runs
// this at boot; whichever wins is idempotent, and the worker must not poll a
// schema it hasn't migrated if it happens to start first.
try {
  await runMigrations();
  log.info("migrations done");
} catch (err) {
  log.error({ err }, "migrations failed");
  process.exit(1);
}

// One declared maxMs per job type, driving BOTH the in-process timeout and the
// reaper's lease. A timeout only fires while this process is alive, so an OOM
// kill or eviction still strands a row at `running`; the reaper is what
// recovers those. Sharing one number keeps the two from drifting apart.
//
// GENERATED_JOBS (S1, Track C): every folded feature's `defineJobs` facet,
// collected by codegen and folded in generically , zero per-feature
// hand-wiring here. Carries `notify` (features/notif) as of commit 2.
// `youtube_ingest` stays hand-wired below until media folds (Wave 6); it is a
// real queue job, not a Worker interval, but its feature isn't a
// codegen-collected facet yet.
const JOBS: JobSpec[] = [
  ...GENERATED_JOBS,
  // A ceiling for pathological downloads, not a target , sets take minutes.
  // Registered only when YOUTUBE_INGEST_ENABLED: an unregistered type is never
  // claimed, so the queued backlog parks in place instead of burning attempts
  // against a YouTube block no retry can clear. Same reason it drops out of the
  // reaper's spec list , there is nothing running left to reap.
  ...(config.YOUTUBE_INGEST_ENABLED
    ? [
        {
          type: "youtube_ingest" as const,
          maxMs: 60 * 60_000,
          // Guard the NAS before each claim: a full volume must not start a
          // download. This lives inside the ingest handler, not on a shared
          // cycle, so a full NAS never blocks `notify` (APNs) delivery, which
          // touches no disk.
          handler: async (payload: unknown, signal: AbortSignal) => {
            if (!hasSufficientDisk(config.MEDIA_STORAGE_DIR)) {
              throw new Error("insufficient disk space for ingest");
            }
            await runYoutubeIngest(payload, signal);
          },
        },
      ]
    : []),
];

const workers: Worker[] = [
  {
    // DB-authoritative light enforcer (www-7d5b.2.6): reconciles desired→HA for the
    // managed lights every ~1s. The sole owner of light/switch reconcile now ,
    // device-sync no longer touches them.
    name: "light-enforcer",
    intervalMs: 1_000,
    runOnStart: true,
    run: runEnforcerCycle,
  },
  {
    // DB-authoritative climate enforcer (www-unxz.2): reconciles desired→HA for the
    // single house thermostat every ~1s (enforce policy , the dashboard wins).
    // Writes real ambient/hvac_action into reportedState so getClimate reads the
    // DB row with no HA call.
    name: "climate-enforcer",
    intervalMs: 1_000,
    runOnStart: true,
    run: runClimateEnforcerCycle,
  },
  {
    // DB-authoritative Sonos volume enforcer (www-5mek): desiredState is truth,
    // the player is the actuator. Reconciles every ~1s , push inside the command
    // window, adopt external changes (Sonos app / hardware buttons) outside it.
    name: "sonos-volume-enforcer",
    intervalMs: 1_000,
    runOnStart: true,
    run: runSonosVolumeEnforcerCycle,
  },
  {
    // Fan-only since the cutover; lights moved to the enforcer above.
    name: "device-sync",
    intervalMs: 1_000,
    runOnStart: true,
    run: runDeviceSyncCycle,
  },
  {
    // Party-mode reconciler (www-7d5b.3.3): reads the lamp_mode DB row + lamp
    // on-state and starts/stops/restarts the in-process party animation engine.
    // DB-row-as-truth makes party durable across worker restarts (re-arms here).
    name: "party-mode",
    intervalMs: 2_000,
    runOnStart: true,
    run: reconcilePartyMode,
  },
  {
    name: "weather-ingest",
    intervalMs: 5 * 60_000,
    runOnStart: true,
    run: runWeatherIngestCycle,
  },
  {
    // Renpho weight ingest (spec 2026-07-21): HA sensor → weight_measurement.
    // 15s so a weigh-in lands within ~30s end-to-end (matches POLL.weight on
    // the panel); ~240 HA polls/hr is trivial.
    name: "weight-ingest",
    intervalMs: 15_000,
    runOnStart: true,
    run: runWeightIngestCycle,
  },
  {
    // Withings direct-API weight ingest (replaces HA's 10min-poll integration
    // for latency): fetches new measurements straight from Withings' cloud
    // API. 10s , faster than the HA path above , because the <30s budget must
    // also absorb Withings' own scale→cloud sync lag, not just this poll's
    // wait. 6 req/min, trivial against Withings' 120/min limit. Inert (quiet
    // no-op) until withings_oauth_token is seeded by the activation runbook.
    name: "withings-weight-ingest",
    intervalMs: 10_000,
    runOnStart: true,
    run: runWithingsWeightIngestCycle,
  },
  {
    // GitHub Actions deploy poller (Deploys tile): 10s tick, but the cycle
    // self-gates to one real poll per 60s while no run is in flight, so idle
    // cost is ~60 req/hr and a deploy is picked up within 10s. A no-op when
    // GITHUB_ACTIONS_TOKEN is unset.
    name: "github-actions-poll",
    intervalMs: 10_000,
    runOnStart: true,
    run: runGithubPollCycle,
  },
  {
    // App Store Connect TestFlight-build poller: upserts the latest installable
    // shell build into asc_build_status so the board can show "update available".
    // 1/min is ~1.7% of ASC's 3600/hr budget; a no-op when ASC_* env is unset.
    name: "asc-version-poll",
    intervalMs: 60_000,
    runOnStart: true,
    run: runAscVersionPollCycle,
  },
  // Paired with the job type above: with ingest off there is nothing to feed,
  // and polling would only grow a backlog of jobs that cannot run.
  ...(config.YOUTUBE_INGEST_ENABLED
    ? [
        {
          // Playlist poller: enumerate each enabled media_source via
          // yt-dlp --flat-playlist and enqueue ingest jobs for unseen video IDs.
          // Metadata only -- no video data -- so 2 minutes is ~720 requests/day
          // from one IP, well inside anything YouTube pushes back on. Going
          // lower buys little: the download itself dominates end-to-end latency.
          name: "playlist-poller",
          intervalMs: 2 * 60_000,
          runOnStart: true,
          run: runPlaylistPollerCycle,
        },
      ]
    : []),
  // One Worker per job type: independent timer chains, so a 1h download cannot
  // delay an APNs push, plus the reaper that recovers rows stranded at
  // `running` by a process death no in-process timeout can observe.
  ...JOBS.map(jobWorker),
  staleJobReaper(JOBS),
];

// Startup line: single unmistakable signal in docker service logs that the
// process booted and configured its logger. See docs/logging.md §6.
log.info({ workers: workers.map((w) => w.name), env: config.NODE_ENV }, "worker started");

const runtime = createWorkerRuntime(workers, { logger: log });
runtime.start();

// Graceful shutdown: stop scheduling new cycles so the orchestrator can replace
// the pod without an in-flight reschedule racing the kill, then hand any job
// this process still holds back to `queued`.
//
// The release is what makes routine deploys cheap. A pod replaced mid-download
// used to strand its row at `running` until the reaper's lease expired (maxMs +
// grace = 65 min for youtube_ingest); now the next pod reclaims it in seconds.
// exit() must therefore run AFTER the release resolves, not synchronously
// alongside it , the old code raced the process death against the UPDATE.
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // A second signal during the release window must not restart the sequence.
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "worker stopping");
    // stop() emits the final per-worker stats snapshot ("worker final stats")
    // so the last known health state is captured before the process exits.
    runtime.stop();
    void releaseInFlightJobsWithTimeout()
      .then((released) => {
        log.info({ signal, released }, "worker stopped");
      })
      .catch((err) => {
        // Never block the exit on a release failure: the reaper still recovers
        // the row, just slowly.
        log.error({ err }, "job release on shutdown failed");
      })
      .finally(() => {
        process.exit(0);
      });
  });
}
