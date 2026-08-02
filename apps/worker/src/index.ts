/**
 * Worker app entrypoint (www-xjba). No HTTP , this is its own deployable package
 * (@control-center/worker) and its own image (control-center-worker), running the
 * continuous reconcile/ingest loops the api used to start in-process. Splitting
 * it out of api keeps the api request-only and lets the loops build, ship,
 * scale, and restart on their own image (www-7d5b.1.2 promoted to a real app).
 *
 * Apps own domain cycles and cadence in features/<id>/worker.ts. Codegen folds
 * those facets into workers.gen.ts; this package owns process lifecycle, queue
 * workers, migrations, metrics, and graceful shutdown.
 */
import "./boot-env";
import {
  type JobSpec,
  jobWorker,
  releaseInFlightJobsWithTimeout,
  runMigrations,
  staleJobReaper,
} from "@control-center/api/worker";
import { GENERATED_JOBS } from "@features/_generated/jobs.gen";
import { GENERATED_WORKERS } from "@features/_generated/workers.gen";
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
  ...GENERATED_WORKERS,
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
