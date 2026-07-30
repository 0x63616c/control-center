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
  runWithingsWeightIngestCycle,
  staleJobReaper,
} from "@control-center/api/worker";
import { GENERATED_JOBS } from "@features/_generated/jobs.gen";
import { runSonosVolumeEnforcerCycle } from "@features/sound/enforcer";
import { runWeatherIngestCycle } from "@features/weather/ingest";
import { createLogger, installFatalHandlers } from "@www/logger";
import { ENV as config } from "@www/platform/env";
import { initMetrics, startMetricsServer } from "@www/platform/metrics";
import { createWorkerRuntime, type Worker } from "@www/worker-runtime";

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
// Feature-owned jobs are collected by codegen. Each gets an independent worker
// and the same declaration drives stale-lease recovery below.
const JOBS: JobSpec[] = [...GENERATED_JOBS];

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
    // Withings direct-API weight ingest: fetches new measurements straight
    // from Withings' cloud API. 10s so a weigh-in lands within ~30s
    // end-to-end (matches POLL.weight on the panel), which must also absorb
    // Withings' own scale→cloud sync lag. 6 req/min, trivial against
    // Withings' 120/min limit.
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
  // One Worker per job type keeps feature-owned work independently scheduled.
  // The reaper recovers rows stranded at `running` by a process death that no
  // in-process timeout can observe.
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
// The release makes routine deploys cheap: the next pod reclaims held jobs in
// seconds instead of waiting for a stale lease. exit() must run AFTER the release resolves, not synchronously
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
