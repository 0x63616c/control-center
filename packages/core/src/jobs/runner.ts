/**
 * Bridge between the durable job queue and the Worker contract (relocated into
 * @www/core at S1, db-injected like queue.ts).
 *
 * A job type does not need its own dispatch machinery: the worker runtime
 * already guarantees a cycle never overlaps itself (per-type concurrency 1),
 * that each worker owns an independent timer chain (a 1h download cannot delay
 * `notify`), and that a throwing cycle never kills a sibling. So a job type is
 * simply a Worker whose cycle drains that one type.
 *
 * Both the per-job timeout and the reaper's lease derive from the same JobSpec,
 * so there is one declared number per type rather than two constants to drift.
 */
import { getLogger } from "@www/logger";
import type { Worker } from "@www/worker-runtime";
import { sql } from "drizzle-orm";
import { claimOne, type JobQueueDb, type JobSpec } from "./queue";

/** How often each job type polls for work. */
const JOB_POLL_INTERVAL_MS = 2_000;

/** How often the reaper sweeps for stranded rows. */
const REAP_INTERVAL_MS = 5 * 60_000;

/**
 * Grace added to each type's maxMs before the reaper considers a row stranded.
 * Absorbs clock skew and the window between a handler's own timeout firing and
 * the row being updated, so the reaper never races a job about to fail itself.
 */
const REAP_GRACE_MS = 5 * 60_000;

/** Wrap a job type as a Worker that drains it, one job per cycle. */
export function jobWorker(db: JobQueueDb, spec: JobSpec): Worker {
  return {
    name: `job:${spec.type}`,
    intervalMs: JOB_POLL_INTERVAL_MS,
    runOnStart: true,
    run: async () => {
      await claimOne(db, spec);
    },
  };
}

/**
 * Requeue jobs stranded at `running`. A timeout only fires while the process is
 * alive, so an OOM kill or pod eviction leaves the row at `running` forever ,
 * invisible to every future claim, because the claim query only selects
 * `queued`. This is the only mechanism that recovers those.
 *
 * Scoped to `status = 'running'` on purpose: rows deliberately parked in
 * `queued` on a future run_after must never be resurrected by a sweep.
 *
 * Handlers must be idempotent because a requeued job can run on another worker.
 *
 * The ceiling on attempts lives here rather than on the claim SELECT: a process
 * death never reaches claimOne's own catch block, so a job that keeps killing
 * its worker (OOM, a poison payload) would otherwise be requeued and reclaimed
 * forever , and because claims order by priority DESC, created_at ASC, that
 * same row would be reselected first on every cycle, permanently crash-looping
 * the shared worker process out from under every other job type and enforcer
 * cycle it hosts. Rows at or past max_attempts are failed here instead, loudly,
 * rather than being silently parked (which `AND attempts < max_attempts` on the
 * claim SELECT would do , that hides the failure instead of recording it).
 *
 * Returns the number of rows requeued (does not count rows failed outright).
 */
export async function reapStaleJobs(db: JobQueueDb, specs: readonly JobSpec[]): Promise<number> {
  let reaped = 0;
  for (const spec of specs) {
    const leaseMs = spec.maxMs + REAP_GRACE_MS;
    const result = await db.execute(
      sql`
        UPDATE job
        SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
            last_error = CASE WHEN attempts >= max_attempts
                         THEN 'stranded at running; attempts exhausted' ELSE last_error END,
            locked_at = null,
            updated_at = now()
        WHERE status = 'running'
          AND type = ${spec.type}
          AND locked_at < now() - make_interval(secs => ${Math.ceil(leaseMs / 1000)})
        RETURNING attempts >= max_attempts AS exhausted
      `,
    );
    const rows = result.rows as Array<{ exhausted: boolean }>;
    const failedCount = rows.filter((r) => r.exhausted).length;
    const requeuedCount = rows.length - failedCount;
    if (requeuedCount > 0) {
      getLogger().warn(
        { type: spec.type, count: requeuedCount, leaseMs },
        "requeued stranded jobs",
      );
      reaped += requeuedCount;
    }
    if (failedCount > 0) {
      getLogger().error(
        { type: spec.type, count: failedCount, leaseMs },
        "stranded jobs permanently failed; attempts exhausted",
      );
    }
  }
  return reaped;
}

/** The reaper as a Worker, built from the same specs used to build job workers. */
export function staleJobReaper(db: JobQueueDb, specs: readonly JobSpec[]): Worker {
  return {
    name: "stale-job-reaper",
    intervalMs: REAP_INTERVAL_MS,
    runOnStart: true,
    run: async () => {
      await reapStaleJobs(db, specs);
    },
  };
}
