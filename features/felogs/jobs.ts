/**
 * Frontend-log retention purge (spec 2026-07-18-frontend-log-shipping-design),
 * folded into the felogs feature (Track C, Wave 7 — was apps/api's
 * frontend-log-purge-service.ts). `frontend_log` is append-only device debug
 * logs shipped from every panel / browser session, so it grows without bound.
 * Retention is the size control (all four levels ship, no level filtering),
 * not backup — each device holds its own copy.
 *
 * Retention policy:
 *  - frontend_log: KEEP 30 days, cut on `ts` (capture time). A row's ts only
 *    ever moves backward relative to now, so a ts cutoff can never delete a row
 *    a live query still wants (reads are always "recent" windows).
 *
 * Runs as a daily Temporal Schedule (ADR-0008, see temporal.ts), never a worker
 * loop (PRD Backend rule 7). Deletes are BATCHED: a single unbounded DELETE
 * would hold one long transaction and bloat WAL. Whatever a run doesn't finish
 * is picked up by the next day's run.
 *
 * jobs.ts now carries only the purge implementation (consumed by
 * activities.ts, ADR-0008) — felogs ingest is a tRPC
 * mutation, not a queue job or worker interval, so this feature has no
 * `defineJobs` facet.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema";

/** Frontend logs are retained for 30 days, then purged. */
export const FRONTEND_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows removed per statement. Small enough to keep each transaction short. */
const PURGE_BATCH_SIZE = 20_000;

/**
 * Upper bound on batches per run, so one job can never run unbounded against a
 * pathologically large backlog. At the batch size above this is 10M rows/run,
 * far more than a day accumulates.
 */
export const MAX_BATCHES = 500;

export interface FrontendLogPurgeCounts {
  logs: number;
  /** True if the loop hit MAX_BATCHES, i.e. a backlog remains for the next run. */
  truncated: boolean;
}

/** The frontend-log retention cutoff for `now`. */
export function frontendLogCutoff(now: Date): Date {
  return new Date(now.getTime() - FRONTEND_LOG_RETENTION_MS);
}

/** A log row is purgeable once it was captured more than the retention window ago. */
export function logShouldPurge(row: { ts: Date }, now: Date): boolean {
  return row.ts.getTime() < frontendLogCutoff(now).getTime();
}

/** Postgres' node driver returns rowCount; treat null/undefined as 0. */
function rows(res: { rowCount?: number | null }): number {
  return res.rowCount ?? 0;
}

/**
 * Run one frontend-log purge pass. Pure of any scheduling; the purge activity calls
 * this once per scheduled run. `ctid` is the physical row address, so
 * the LIMIT subquery picks a cheap arbitrary set of matching rows without a sort.
 */
export async function purgeFrontendLogs(
  db: NodePgDatabase<typeof schema>,
  now: Date = new Date(),
): Promise<FrontendLogPurgeCounts> {
  const cutoff = frontendLogCutoff(now);
  let deleted = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const res = await db.execute(sql`
      delete from "frontend_log"
      where ctid in (
        select ctid from "frontend_log"
        where ts < ${cutoff}
        limit ${PURGE_BATCH_SIZE}
      )
    `);
    const n = rows(res);
    deleted += n;
    if (n === 0) return { logs: deleted, truncated: false };
  }

  return { logs: deleted, truncated: true };
}
