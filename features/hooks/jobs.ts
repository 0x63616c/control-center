/**
 * `incoming_webhook` retention purge (#126), matching `frontend_log`'s 30 days.
 *
 * Deliveries are append-only and arrive at whatever rate the repo is active at,
 * so retention is the size control. Deletes are BATCHED: one unbounded DELETE
 * would hold a long transaction and bloat WAL. Whatever a run does not finish is
 * picked up by the next day's.
 *
 * Runs as a daily Temporal Schedule (ADR-0008, see temporal.ts), never a worker loop.
 */
import { sql } from "drizzle-orm";
import { db } from "./db";

/** Deliveries are retained for 30 days, then purged. */
const INCOMING_WEBHOOK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows removed per statement, small enough to keep each transaction short. */
const PURGE_BATCH_SIZE = 20_000;

/** Upper bound on batches per run, so one job can never run unbounded. */
const MAX_BATCHES = 500;

export async function purgeIncomingWebhooks(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - INCOMING_WEBHOOK_RETENTION_MS);
  let deleted = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const result = await db.execute(sql`
      delete from incoming_webhook
      where delivery_id in (
        select delivery_id from incoming_webhook
        where received_at < ${cutoff.toISOString()}
        limit ${PURGE_BATCH_SIZE}
      )
    `);
    const count = result.rowCount ?? 0;
    deleted += count;
    if (count < PURGE_BATCH_SIZE) break;
  }

  return deleted;
}
