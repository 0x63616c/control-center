/**
 * Thin binder over the generic durable job queue now owned by @www/core (S1).
 * apps/api's tests and the `@control-center/api/worker` barrel keep importing
 * from this path with their pre-move signatures , the db is bound here once
 * instead of threaded through every call site. `enqueueJob` itself is NOT
 * re-exported here: API call sites do not produce durable jobs; feature-owned
 * producers call core.enqueueJob with their own database handle.
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
