/**
 * GitHub run-history retention purge (Track C shell-cleanup fold — was
 * apps/api's github-purge-service.ts, driven by the bundled purge.js
 * one-shot). `github_run` accumulates one row per main workflow run; 30 days
 * of history is all the Deploys tile ever shows, so older rows (and their log
 * tails) go.
 *
 * The github_poll_status singleton is NEVER touched here: it carries the
 * currently-deployed pointer, and purging it when the last deploy is >30 days
 * old would leave the tile unable to say what is deployed at all. Purge the
 * history, keep the pointer.
 *
 * Runs as a daily Temporal Schedule (ADR-0008, see temporal.ts), never a worker
 * loop (PRD Backend rule 7). Volume is trivial (a few hundred rows a month),
 * so a single bounded DELETE per table is enough, no batching.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema";

/** GitHub run history is retained for 30 days, then purged. */
export const GITHUB_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface GithubPurgeCounts {
  runs: number;
  logTails: number;
}

/** The github-run retention cutoff for `now`. */
export function githubRunCutoff(now: Date): Date {
  return new Date(now.getTime() - GITHUB_RUN_RETENTION_MS);
}

/** A run row is purgeable once it started more than the retention window ago. */
export function runShouldPurge(row: { startedAtUtc: Date }, now: Date): boolean {
  return row.startedAtUtc.getTime() < githubRunCutoff(now).getTime();
}

/** Run one github-run purge pass: expired runs plus their log tails. */
export async function purgeGithubRuns(
  db: NodePgDatabase<typeof schema>,
  now: Date = new Date(),
): Promise<GithubPurgeCounts> {
  const cutoff = githubRunCutoff(now);
  // Log tails first (they reference run ids), then the runs themselves.
  const tailRes = await db.execute(sql`
    delete from "github_run_log_tail"
    where run_id in (select id from "github_run" where started_at_utc < ${cutoff})
  `);
  const runRes = await db.execute(sql`
    delete from "github_run" where started_at_utc < ${cutoff}
  `);
  return { runs: runRes.rowCount ?? 0, logTails: tailRes.rowCount ?? 0 };
}
