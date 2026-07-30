/**
 * Thin binder over the generic durable job queue now owned by @www/core (S1).
 * apps/api's tests and the `@control-center/api/worker` barrel keep importing
 * from this path with their pre-move signatures , the db is bound here once
 * instead of threaded through every call site. `enqueueJob` itself is NOT
 * re-exported here: apps/api no longer enqueues (the last producer,
 * playlist-poller/addUrls, moved into features/sound in the media split,
 * Track C Wave 6, calling core.enqueueJob directly with the feature's own db).
 */
import * as core from "@www/core";
import { db } from "../db/index";

export type { JobSpec } from "@www/core";

export function releaseInFlightJobsWithTimeout(timeoutMs?: number): Promise<number> {
  return core.releaseInFlightJobsWithTimeout(db, timeoutMs);
}

export function jobWorker(spec: core.JobSpec): ReturnType<typeof core.jobWorker> {
  return core.jobWorker(db, spec);
}

export function staleJobReaper(
  specs: readonly core.JobSpec[],
): ReturnType<typeof core.staleJobReaper> {
  return core.staleJobReaper(db, specs);
}
