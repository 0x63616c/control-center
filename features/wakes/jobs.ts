/**
 * Wake-photo retention purge (Track C, Wave 5 fold — was apps/api's
 * wake-photo-purge-service.ts).
 *
 * Wake photos were the only media the control-center kept with no retention at
 * all , the filesystem tree was the store, and a tree has no cheap "older than"
 * query, so nothing ever deleted them. The index row (see photos.ts)
 * is what makes a cutoff affordable.
 *
 * Retention: KEEP 90 days, cut on `captured_at`. Longer than the 30-day
 * frontend-log window on purpose , a photo is the only record of WHO was at the
 * panel, and it is far smaller per-event than the log lines it accompanies.
 *
 * Rows and files are deleted together, ROW FIRST: an orphaned file is invisible
 * (nothing lists from disk any more) and is re-indexed by the boot backfill then
 * purged again next run, whereas an orphaned row 404s in the viewer.
 *
 * Runs as a daily Temporal Schedule (ADR-0008, see temporal.ts), never a worker
 * loop (PRD Backend rule 7). Staggered off guest-wifi (0 2) + weather (0 3) +
 * felogs.
 *
 * jobs.ts now carries only the purge implementation (consumed by
 * activities.ts, ADR-0008) , wake capture is a browser-side
 * best-effort burst, not a worker job, so this feature has no `defineJobs`
 * facet.
 */
import { getLogger } from "@www/logger";
import { asc, eq, lt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { defaultWakePhotoRoot, deleteWakePhotoFile } from "./photos";
import type * as schema from "./schema";
import { wakePhoto } from "./schema";

/** Wake photos are retained for 90 days, then purged. */
export const WAKE_PHOTO_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Rows removed per batch. Each row is also a file unlink, so keep it modest. */
const PURGE_BATCH_SIZE = 500;

/** Upper bound on batches per run, so one job can never run unbounded. */
const MAX_BATCHES = 200;

/** The wake-photo retention cutoff for `now`. */
export function wakePhotoCutoff(now: Date): Date {
  return new Date(now.getTime() - WAKE_PHOTO_RETENTION_MS);
}

/**
 * Run one wake-photo purge pass: delete index rows past the cutoff and unlink
 * their files. Pure of any scheduling; the purge activity calls
 * this once and exits.
 */
export async function purgeWakePhotos(
  db: NodePgDatabase<typeof schema>,
  root = defaultWakePhotoRoot(),
  now: Date = new Date(),
): Promise<{ photos: number; truncated: boolean }> {
  const cutoff = wakePhotoCutoff(now);
  let deleted = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const doomed = await db
      .select({ path: wakePhoto.path })
      .from(wakePhoto)
      .where(lt(wakePhoto.capturedAt, cutoff))
      .orderBy(asc(wakePhoto.capturedAt))
      .limit(PURGE_BATCH_SIZE);
    if (doomed.length === 0) return { photos: deleted, truncated: false };

    for (const { path } of doomed) {
      await db.delete(wakePhoto).where(eq(wakePhoto.path, path));
      // A missing file is fine , the row is what the viewer reads, and this is
      // exactly the orphan case the row-first order deliberately allows.
      await deleteWakePhotoFile(path, root);
      deleted += 1;
    }
  }

  getLogger().info({ deleted }, "wake photo purge hit its batch cap");
  return { photos: deleted, truncated: true };
}
