/**
 * Weather-reading retention purge (Track C, Wave 7 fold — was apps/api's
 * weather-purge-service.ts). Both weather tables are append-only by design
 * (the ingest poller inserts a fresh row per forecast hour every cycle so
 * run-over-run forecast drift is preserved), which means they grow without
 * bound: ~192 hourly rows + 8 daily rows per cycle, 288 cycles/day, is roughly
 * 55k weather_reading rows/day forever.
 *
 * Retention policy:
 *  - weather_reading / weather_daily_reading: KEEP 30 days of history, cut on
 *    `recorded_at` (when we captured the row), NOT on target_hour/target_date.
 *    Rows describing future hours are always recently recorded, so a recorded_at
 *    cutoff can never delete a row the dashboard still reads
 *    (service.ts only queries from today/now forward).
 *
 * Runs as a daily Temporal Schedule (ADR-0008, see temporal.ts — formerly the
 * S2 k8s CronJob seam), never a worker loop (PRD Backend rule 7). Deletes are
 * BATCHED: the first production run has millions of rows to remove and a
 * single unbounded DELETE would hold one long transaction and bloat WAL. Each
 * batch is its own statement; whatever a run doesn't finish is picked up by
 * the next day's run.
 *
 * jobs.ts now carries only the purge implementation (consumed by
 * activities.ts) — weather-ingest is a Worker interval, not a queue job, so
 * this feature has no `defineJobs` facet and, since the Temporal migration,
 * no `defineCron` either.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema";

/** Weather readings are retained for 30 days, then purged. */
export const WEATHER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows removed per statement. Small enough to keep each transaction short. */
const PURGE_BATCH_SIZE = 20_000;

/**
 * Upper bound on batches per table per run, so one job can never run unbounded
 * against a pathologically large backlog. At the batch size above this is 10M
 * rows/table/run, far more than a day accumulates.
 */
export const MAX_BATCHES_PER_TABLE = 500;

export interface WeatherPurgeCounts {
  readings: number;
  dailyReadings: number;
  /** True if a table hit MAX_BATCHES_PER_TABLE, i.e. a backlog remains. */
  truncated: boolean;
}

/** The weather retention cutoff for `now`. */
export function weatherCutoff(now: Date): Date {
  return new Date(now.getTime() - WEATHER_RETENTION_MS);
}

/** A reading is purgeable once it was recorded more than the retention window ago. */
export function readingShouldPurge(row: { recordedAt: Date }, now: Date): boolean {
  return row.recordedAt.getTime() < weatherCutoff(now).getTime();
}

/** Postgres' node driver returns rowCount; treat null/undefined as 0. */
function rows(res: { rowCount?: number | null }): number {
  return res.rowCount ?? 0;
}

/**
 * Delete rows older than `cutoff` from one table, in batches, until a batch
 * comes back empty or the batch cap is hit. `ctid` is the physical row address,
 * so the LIMIT subquery picks an arbitrary but cheap set of matching rows
 * without needing to sort by a key.
 */
async function purgeTable(
  db: NodePgDatabase<typeof schema>,
  table: string,
  cutoff: Date,
): Promise<{ deleted: number; truncated: boolean }> {
  let deleted = 0;

  for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch++) {
    const res = await db.execute(sql`
      delete from ${sql.identifier(table)}
      where ctid in (
        select ctid from ${sql.identifier(table)}
        where recorded_at < ${cutoff}
        limit ${PURGE_BATCH_SIZE}
      )
    `);
    const n = rows(res);
    deleted += n;
    if (n === 0) return { deleted, truncated: false };
  }

  return { deleted, truncated: true };
}

/**
 * Run one weather purge pass. Pure of any scheduling; the CronJob's purge
 * entrypoint calls this once and exits.
 */
export async function purgeWeatherData(
  db: NodePgDatabase<typeof schema>,
  now: Date = new Date(),
): Promise<WeatherPurgeCounts> {
  const cutoff = weatherCutoff(now);

  const readings = await purgeTable(db, "weather_reading", cutoff);
  const dailyReadings = await purgeTable(db, "weather_daily_reading", cutoff);

  return {
    readings: readings.deleted,
    dailyReadings: dailyReadings.deleted,
    truncated: readings.truncated || dailyReadings.truncated,
  };
}
