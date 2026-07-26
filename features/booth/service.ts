import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { nextFreeName } from "@www/core";
import { getLogger } from "@www/logger";
import { genId } from "@www/platform";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { config } from "./config";
import type * as schema from "./schema";
import { boothPhoto } from "./schema";

/**
 * Photo booth: the wall panel's on-demand camera. A person triggers a capture in
 * one of four modes , a single `photo`, a `burst` of stills, a `four_frame`
 * strip, or an animated `gif` , and the frames land here. Like wake photos the
 * BYTES live on the filesystem at
 * <MEDIA_STORAGE_DIR>/booth-photos/<capturedAt ISO>-<n>.<ext> (see @www/core media-path);
 * the INDEX
 * lives in Postgres (`booth_photo`), one row per frame.
 *
 * Two things separate it from the wake-photo stack it is modelled on:
 *   - Frames of one multi-frame capture share a `groupId`, so the gallery renders
 *     a burst or strip as a single item rather than N loose stills.
 *   - A `softDeletedAt` stamp gives the gallery a reversible remove: a stamped
 *     frame drops out of every read but its bytes stay on disk.
 */

export const BOOTH_PHOTO_MODES = ["photo", "burst", "four_frame", "gif"] as const;
export type BoothPhotoMode = (typeof BOOTH_PHOTO_MODES)[number];

// Filter ids are short slugs the web maps to CSS (e.g. 'noir', 'warm_70s'). The
// backend stores the string verbatim but pins its shape so no arbitrary text
// (or a filter-name injection) can reach the row. Shared with the upload route.
export const BOOTH_FILTER_PATTERN = /^[a-z0-9_]{1,32}$/;

/** True for null (unfiltered) or a well-formed filter id; false for a bad slug. */
function isValidBoothFilter(filter: string | null): boolean {
  return filter === null || BOOTH_FILTER_PATTERN.test(filter);
}

export interface BoothPhotoMeta {
  capturedAt: number;
  mode: BoothPhotoMode;
  /** Ties the frames of one capture together (bpg_<id>). */
  groupId: string;
  /** 0-based position within the group. */
  frameIdx: number;
  deviceId: string | null;
  /**
   * Non-destructive filter id (web owns id->CSS). Null for an unfiltered shot or
   * a gif (baked in client-side). A non-null value must match BOOTH_FILTER_PATTERN.
   */
  filter: string | null;
  /**
   * A source-only frame is stored for future re-assembly but never shown in the
   * gallery. It relaxes the format-vs-mode check: a gif capture's raw JPEG frames
   * upload under mode 'gif' with sourceOnly=true. Defaults to false.
   */
  sourceOnly: boolean;
}

export interface BoothPhotoSaved {
  id: string;
  /** Path relative to the booth-photos root; what GET /media/booth-photos/<path> serves. */
  path: string;
}

interface BoothPhotoFrame {
  id: string;
  path: string;
  capturedAt: number;
  frameIdx: number;
  mimeType: string;
  /** Non-destructive filter id, or null. */
  filter: string | null;
}

interface BoothPhotoGroup {
  groupId: string;
  mode: BoothPhotoMode;
  /** Newest frame's capture time; the gallery orders groups by it. */
  capturedAt: number;
  /** The group's filter (the newest frame's), or null. Frames of one capture share it. */
  filter: string | null;
  frames: BoothPhotoFrame[];
}

export interface BoothPhotoListing {
  groups: BoothPhotoGroup[];
  totalCount: number;
  totalBytes: number;
}

// Format sniffing. The panel only ever uploads a JPEG still or a GIF animation;
// the magic bytes pick the mime type and the on-disk extension, and are checked
// against the declared mode so a mislabeled body can't be stored.
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38]; // "GIF8" , covers 87a and 89a.
// GIFs (many frames) run larger than a single still, so they get a roomier cap.
const MAX_JPEG_BYTES = 4 * 1024 * 1024;
const MAX_GIF_BYTES = 16 * 1024 * 1024;

export function defaultBoothPhotoRoot(): string {
  return join(config.MEDIA_STORAGE_DIR, "booth-photos");
}

function newBoothPhotoId(): string {
  return genId("bph", { length: 16 });
}

/** New capture-group id, shared by every frame of one burst/strip. */
export function newBoothGroupId(): string {
  return genId("bpg", { length: 16 });
}

function hasMagic(bytes: Uint8Array, magic: number[]): boolean {
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

/**
 * Validate and persist one captured frame: bytes to disk, index row to Postgres.
 * Returns the new id and the stored path (relative to the booth-photos root,
 * the same path GET /media/booth-photos/<path> serves). Throws on an unknown
 * mode, a body whose format contradicts the mode, or an oversize body
 * (services-throw convention).
 *
 * Disk write happens FIRST: a failed row insert leaves an unindexed file (an
 * orphan the listing simply never shows), whereas the reverse would leave a row
 * pointing at bytes that do not exist and 404 in the gallery.
 */
export async function saveBoothPhoto(
  db: NodePgDatabase<typeof schema>,
  bytes: Uint8Array,
  meta: BoothPhotoMeta,
  root = defaultBoothPhotoRoot(),
): Promise<BoothPhotoSaved> {
  if (!BOOTH_PHOTO_MODES.includes(meta.mode)) {
    throw new Error(`unknown booth photo mode: ${meta.mode}`);
  }
  if (!isValidBoothFilter(meta.filter)) {
    throw new Error(`invalid booth photo filter: ${meta.filter}`);
  }

  // Sniff the real format from the bytes. The stored mime/extension follow what
  // the body ACTUALLY is, not what the mode claims , which is what lets a gif
  // group carry raw JPEG source frames.
  const detected = hasMagic(bytes, GIF_MAGIC) ? "gif" : hasMagic(bytes, JPEG_MAGIC) ? "jpeg" : null;
  if (detected === null) {
    throw new Error(meta.mode === "gif" ? "booth gif is not a GIF" : "booth photo is not a JPEG");
  }
  // Strict path: a normal (non-source) upload's format must match its mode. A
  // source-only frame skips this , its format is validated by the magic sniff
  // above, and it is deliberately allowed to differ from the group's mode.
  if (!meta.sourceOnly) {
    if (meta.mode === "gif" && detected !== "gif") throw new Error("booth gif is not a GIF");
    if (meta.mode !== "gif" && detected !== "jpeg") throw new Error("booth photo is not a JPEG");
  }

  const isGif = detected === "gif";
  if (isGif) {
    if (bytes.length > MAX_GIF_BYTES) {
      throw new Error(`booth gif too large: ${bytes.length} bytes (max ${MAX_GIF_BYTES})`);
    }
  } else {
    if (bytes.length > MAX_JPEG_BYTES) {
      throw new Error(`booth photo too large: ${bytes.length} bytes (max ${MAX_JPEG_BYTES})`);
    }
  }

  const mimeType = isGif ? "image/gif" : "image/jpeg";
  const ext = isGif ? "gif" : "jpg";

  await mkdir(root, { recursive: true });
  // Frames of one capture stamp their own times but can collide on a same-ms
  // capture or retry; suffix with the first free counter so every frame keeps a
  // distinct path.
  const relPath = await nextFreeName(root, meta.capturedAt, ext);
  await writeFile(join(root, relPath), bytes);

  const id = newBoothPhotoId();
  await db.insert(boothPhoto).values({
    id,
    path: relPath,
    capturedAt: new Date(meta.capturedAt),
    mode: meta.mode,
    groupId: meta.groupId,
    frameIdx: meta.frameIdx,
    mimeType,
    bytes: bytes.length,
    deviceId: meta.deviceId,
    filter: meta.filter,
    sourceOnly: meta.sourceOnly,
    softDeletedAt: null,
  });

  getLogger().info(
    {
      id,
      relPath,
      mode: meta.mode,
      groupId: meta.groupId,
      filter: meta.filter,
      sourceOnly: meta.sourceOnly,
      bytes: bytes.length,
    },
    "booth photo stored",
  );
  return { id, path: relPath };
}

/**
 * Gallery listing: live (not soft-deleted) frames grouped by capture, newest
 * group first, frames within a group ordered by frame index.
 *
 * Reads the whole index and groups in application code (as the wake-photo
 * listing does): the booth is a home appliance, the row count is small, and
 * keeping the soft-delete filter and grouping here keeps the query trivial.
 */
export async function listBoothPhotos(
  db: NodePgDatabase<typeof schema>,
): Promise<BoothPhotoListing> {
  const rows = await db.select().from(boothPhoto).orderBy(desc(boothPhoto.capturedAt));

  const byGroup = new Map<string, BoothPhotoGroup>();
  let totalCount = 0;
  let totalBytes = 0;
  for (const row of rows) {
    if (row.softDeletedAt != null) continue;
    // Source-only frames (a gif's raw stills) exist for re-assembly, never for
    // display , so a gif group surfaces as just its assembled .gif.
    if (row.sourceOnly) continue;
    totalCount++;
    totalBytes += row.bytes;
    const capturedAt = row.capturedAt.getTime();
    let group = byGroup.get(row.groupId);
    if (!group) {
      group = {
        groupId: row.groupId,
        mode: row.mode as BoothPhotoMode,
        capturedAt,
        // Rows arrive newest-first, so the first-seen frame is the newest: its
        // filter represents the group (frames of one capture share a filter).
        filter: row.filter,
        frames: [],
      };
      byGroup.set(row.groupId, group);
    }
    // Rows arrive newest-first, so a group's first-seen frame is its newest.
    group.capturedAt = Math.max(group.capturedAt, capturedAt);
    group.frames.push({
      id: row.id,
      path: row.path,
      capturedAt,
      frameIdx: row.frameIdx,
      mimeType: row.mimeType,
      filter: row.filter,
    });
  }

  const groups = [...byGroup.values()].sort((a, b) => b.capturedAt - a.capturedAt);
  for (const group of groups) group.frames.sort((a, b) => a.frameIdx - b.frameIdx);

  return { groups, totalCount, totalBytes };
}

/**
 * Reversibly remove a whole capture: stamp `softDeletedAt` on every live frame
 * of the group. The bytes stay on disk (a later hard purge can reclaim them);
 * every read already skips stamped frames. Returns how many frames it hid.
 */
export async function softDeleteBoothGroup(
  db: NodePgDatabase<typeof schema>,
  groupId: string,
): Promise<{ removed: number }> {
  const res = await db
    .update(boothPhoto)
    .set({ softDeletedAt: new Date() })
    .where(and(eq(boothPhoto.groupId, groupId), isNull(boothPhoto.softDeletedAt)));
  const removed = res.rowCount ?? 0;
  getLogger().info({ groupId, removed }, "booth photo group removed");
  return { removed };
}

/**
 * Non-destructively drop the filter from a whole capture: null `filter` on every
 * live frame of the group. The original (unfiltered) bytes were always what was
 * stored , the filter is a display id the web applies , so this just returns the
 * capture to its bare look. Returns how many frames it cleared. Idempotent: a
 * group with no filter clears zero.
 */
export async function clearBoothGroupFilter(
  db: NodePgDatabase<typeof schema>,
  groupId: string,
): Promise<{ cleared: number }> {
  const res = await db
    .update(boothPhoto)
    .set({ filter: null })
    .where(and(eq(boothPhoto.groupId, groupId), isNull(boothPhoto.softDeletedAt)));
  const cleared = res.rowCount ?? 0;
  getLogger().info({ groupId, cleared }, "booth photo group filter cleared");
  return { cleared };
}

/**
 * Read one stored frame by its listing path. Returns null for missing files or
 * any path that escapes the booth-photos root (traversal), so the route layer
 * can 404 both without distinguishing.
 */
export async function readBoothPhoto(
  relPath: string,
  root = defaultBoothPhotoRoot(),
): Promise<{ bytes: Uint8Array<ArrayBuffer> } | null> {
  const abs = resolve(root, relPath);
  if (abs !== resolve(root) && !abs.startsWith(resolve(root) + sep)) return null;
  try {
    return { bytes: new Uint8Array(await readFile(abs)) };
  } catch {
    return null;
  }
}
