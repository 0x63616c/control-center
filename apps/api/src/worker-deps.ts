/**
 * Barrel of everything the worker app (@control-center/worker) needs from the api domain
 * (www-xjba). The worker package owns the scheduling framework + job registry;
 * the actual reconcile/ingest cycles, the env, and the migrator still live here
 * and are re-exported through the `@control-center/api/worker` subpath so worker has a
 * single, explicit import surface rather than reaching into internal paths.
 *
 * There is one barrel because there is one worker app: since media-worker was
 * folded into worker, that single process owns every loop and every job type ,
 * the home-control enforcers, the pollers, and the whole durable queue. Job
 * handlers are plain exported functions the entrypoint passes into jobWorker,
 * so what runs is readable at the call site rather than hidden in a registry.
 *
 * Interim: this barrel is the documented seam between worker and api. The planned
 * packages/core extraction (shared domain) will move these out of api and
 * delete this file; until then, keep the export surface minimal.
 *
 * No env re-export and no hydrate side-effect import here anymore: the worker
 * hydrates via its own pinned `./boot-env` (apps/worker/src/index.ts) and reads
 * config directly from `@www/platform/env`. Feature configs are lazy, so the
 * deploys re-export below no longer risks baking a pre-hydration default.
 */

export { runGithubPollCycle } from "@features/deploys/service";
export { runMigrations } from "./db/migrate";
// Durable job queue (now @www/core, bound to apps/api's db behind ./jobs/queue).
// Each type is wrapped as its own Worker at the entrypoint.
// Graceful shutdown: hand claimed rows back to `queued` instead of stranding
// them at `running` until the reaper's lease expires.
export {
  type JobSpec,
  jobWorker,
  releaseInFlightJobsWithTimeout,
  staleJobReaper,
} from "./jobs/queue";
export { runAscVersionPollCycle } from "./services/asc-version-service";
export { runClimateEnforcerCycle } from "./services/climate-enforcer-service";
export { runDeviceSyncCycle } from "./services/device-sync-service";
export { runEnforcerCycle } from "./services/light-enforcer-service";
export { reconcilePartyMode } from "./services/party-service";
export { runWithingsWeightIngestCycle } from "./services/withings-weight-service";
