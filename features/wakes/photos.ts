import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { nextFreeName, parsePhotoFileName } from "@www/core";
import { getLogger } from "@www/logger";
import { desc } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { config } from "./config";
import type * as schema from "./schema";
import { wakePhoto } from "./schema";

/**
 * Wake photos: front-camera burst frames the wall panel uploads every time it
 * is woken from its idle dim. The BYTES live on the filesystem at
 * <MEDIA_STORAGE_DIR>/wake-photos/<capturedAt ISO>-<n>.jpg (see @www/core media-path);
 * the INDEX lives in Postgres (`wake_photo`), one row per frame, carrying the
 * interaction session the frame belongs to (spec
 * docs/specs/2026-07-18-interaction-logging-design.md).
 *
 * A dated YYYY/MM/DD tree used to BE the store , listing walked it, and an epoch
 * stamp in a filename was the only metadata a photo had. The table is what lets
 * a frame be correlated with a session, attributed to a device, and purged by a
 * cheap cutoff query. `backfillWakePhotoIndex` heals the gap for photos that
 * predate the table (their rows are honestly NULL on everything the filename
 * never carried).
 */

interface WakePhotoDay {
  /** YYYY-MM-DD */
  day: string;
  photos: {
    path: string;
    capturedAt: number;
    /**
     * The visit this frame belongs to, so the viewer can open the session it
     * came from. Null for frames that predate the session table (backfilled)
     * or whose burst was never correlated , honestly unopenable.
     */
    interactionSessionId: string | null;
  }[];
}

export interface WakePhotoListing {
  days: WakePhotoDay[];
  totalCount: number;
  totalBytes: number;
}

export interface WakePhotoMeta {
  capturedAt: number;
  deviceId: string | null;
  sessionId: string | null;
  /** 0-based position within the burst. */
  frameIdx: number;
}

/** JPEG SOI + marker prefix , the only content type the panel uploads. */
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const MAX_BYTES = 2 * 1024 * 1024;

export function defaultWakePhotoRoot(): string {
  return join(config.MEDIA_STORAGE_DIR, "wake-photos");
}

/**
 * Validate and persist one burst frame: bytes to disk, index row to Postgres.
 * Returns the stored path relative to the wake-photos root (the same path
 * GET /media/wake-photos/<rel> serves). Throws on non-JPEG content or oversize
 * bodies (services-throw convention).
 *
 * Disk write happens FIRST. If the row insert then fails we are left with an
 * unindexed file, which the backfill (see backfillWakePhotoIndex) heals; the
 * reverse order would leave a row pointing at bytes that do not exist, which
 * nothing can heal and which 404s in the viewer.
 */
export async function saveWakePhoto(
  db: NodePgDatabase<typeof schema>,
  bytes: Uint8Array,
  meta: WakePhotoMeta,
  root = defaultWakePhotoRoot(),
): Promise<string> {
  if (bytes.length > MAX_BYTES) {
    throw new Error(`wake photo too large: ${bytes.length} bytes (max ${MAX_BYTES})`);
  }
  if (bytes.length < JPEG_MAGIC.length || !JPEG_MAGIC.every((b, i) => bytes[i] === b)) {
    throw new Error("wake photo is not a JPEG");
  }
  await mkdir(root, { recursive: true });
  // Burst frames share a wake but not a timestamp (each frame stamps its own
  // capture time), so collisions only happen on a same-ms retry , suffix with
  // the first free counter so every frame keeps a distinct path.
  const relPath = await nextFreeName(root, meta.capturedAt, "jpg");
  await writeFile(join(root, relPath), bytes);

  await db
    .insert(wakePhoto)
    .values({
      path: relPath,
      capturedAt: new Date(meta.capturedAt),
      interactionSessionId: meta.sessionId,
      deviceId: meta.deviceId,
      frameIdx: meta.frameIdx,
      bytes: bytes.length,
    })
    // A same-path retry re-uploads identical bytes; the row is already correct.
    .onConflictDoNothing();

  getLogger().info(
    { relPath, bytes: bytes.length, sessionId: meta.sessionId },
    "wake photo stored",
  );
  return relPath;
}

/**
 * List what is physically on disk. Retained (from the tree-walk listing era) as
 * the backfill's source of truth , the filesystem is authoritative for BYTES,
 * the table for metadata.
 *
 * Reads only the flat root. Legacy YYYY/MM/DD names are NOT read here: the
 * migration renames every one of them into the flat scheme, so a leftover
 * nested file is a migration failure to investigate, not something to silently
 * index at a timestamp this parser would have to guess at.
 */
async function walkPhotoFiles(
  root: string,
): Promise<{ path: string; capturedAt: number; bytes: number }[]> {
  const out: { path: string; capturedAt: number; bytes: number }[] = [];

  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return out;
  }

  for (const name of names) {
    const parsed = parsePhotoFileName(name);
    if (parsed?.ext !== "jpg") continue;
    const s = await stat(join(root, name)).catch(() => null);
    if (!s?.isFile()) continue;
    out.push({ path: name, capturedAt: parsed.capturedAt, bytes: s.size });
  }

  return out;
}

/**
 * Index every photo on disk that has no row yet.
 *
 * The filesystem was the store for the whole life of this feature, so history
 * predates the table. Idempotent (`onConflictDoNothing` on the path PK) so it is
 * safe to run on every api boot , which is how it runs, rather than as a
 * one-shot script someone has to remember to invoke.
 *
 * Backfilled rows are honestly incomplete: the old filename encoded only a
 * capture timestamp, so session, device and frame index are all NULL. That is
 * the truth about those photos and the viewer renders them as unattributed
 * rather than guessing.
 */
export async function backfillWakePhotoIndex(
  // apps/api's server.ts calls this at boot with ITS OWN db handle (typed to
  // apps/api's schema, which no longer includes wakePhoto now that the table
  // moved here). The query builder calls below (.insert/.values/
  // .onConflictDoNothing) only need the `wakePhoto` table object, not the db's
  // schema generic , that generic only types `db.query.*`, unused here , so
  // the schema generic is widened to accept either caller's db structurally.
  // biome-ignore lint/suspicious/noExplicitAny: see comment above
  db: NodePgDatabase<any>,
  root = defaultWakePhotoRoot(),
): Promise<{ inserted: number; scanned: number }> {
  const onDisk = await walkPhotoFiles(root);
  if (onDisk.length === 0) return { inserted: 0, scanned: 0 };

  let inserted = 0;
  for (const photo of onDisk) {
    const res = await db
      .insert(wakePhoto)
      .values({
        path: photo.path,
        capturedAt: new Date(photo.capturedAt),
        interactionSessionId: null,
        deviceId: null,
        frameIdx: null,
        bytes: photo.bytes,
      })
      .onConflictDoNothing();
    inserted += res.rowCount ?? 0;
  }
  return { inserted, scanned: onDisk.length };
}

/**
 * Day-grouped listing, newest first, read from the index.
 *
 * Returns the identical shape the tree walk did , the viewer and tile are
 * unchanged by the storage move.
 */
export async function listWakePhotos(db: NodePgDatabase<typeof schema>): Promise<WakePhotoListing> {
  const rows = await db.select().from(wakePhoto).orderBy(desc(wakePhoto.capturedAt));

  const byDay = new Map<string, WakePhotoDay>();
  let totalBytes = 0;
  for (const row of rows) {
    const day = row.capturedAt.toISOString().slice(0, 10);
    let bucket = byDay.get(day);
    if (!bucket) {
      bucket = { day, photos: [] };
      byDay.set(day, bucket);
    }
    bucket.photos.push({
      path: row.path,
      capturedAt: row.capturedAt.getTime(),
      interactionSessionId: row.interactionSessionId,
    });
    totalBytes += row.bytes;
  }

  return { days: [...byDay.values()], totalCount: rows.length, totalBytes };
}

/**
 * Read one stored photo by its listing path. Returns null for missing files or
 * any path that escapes the wake-photos root (traversal), so the route layer
 * can 404 both without distinguishing.
 */
export async function readWakePhoto(
  relPath: string,
  root = defaultWakePhotoRoot(),
): Promise<{ bytes: Uint8Array<ArrayBuffer> } | null> {
  const abs = resolve(root, relPath);
  if (abs !== resolve(root) && !abs.startsWith(resolve(root) + sep)) return null;
  try {
    return { bytes: new Uint8Array(await readFile(abs)) };
  } catch {
    return null;
  }
}
