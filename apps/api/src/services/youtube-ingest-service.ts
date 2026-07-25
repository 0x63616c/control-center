/**
 * youtube_ingest job handler (www-kp4k.4 + www-kp4k.5). Given a mediaItemId:
 *   1. Validates the item exists and is not already done.
 *   2. Downloads one video-only file (audio is muxed inside the container) plus
 *      its thumbnail via a single yt-dlp call. NEVER re-transcodes , we pick the
 *      AV1 stream YouTube already serves.
 *   3. Records the file path, byte size, and duration in media_item.
 *   4. Sets status = 'ready' (or updates error on throw).
 *
 * Idempotent: if status is already 'ready', the handler is a no-op. The queue
 * handles retries via claimOne.
 *
 * Exported as runYoutubeIngest and wired into the worker's JOBS array; the
 * job:youtube_ingest worker is what drains it.
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { mediaItem } from "@features/sound/schema";
import { getLogger } from "@www/logger";
import { ENV as config } from "@www/platform/env";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import type { JobHandler } from "../jobs/queue";

const execFileAsync = promisify(execFile);

/** Payload written by playlist-poller when enqueueing youtube_ingest jobs. */
interface YoutubeIngestPayload {
  mediaItemId: string;
  videoId: string;
}

/**
 * Download one video (audio is inside the muxed container) plus its thumbnail.
 *
 * YouTube serves video and audio as separate DASH streams above 360p; the `+`
 * in the selector makes ffmpeg mux them into one file. AV1 is preferred as the
 * most efficient codec YouTube serves; the fallback after `/` is a pre-combined
 * stream. We never re-encode -- both paths are stream copies.
 *
 * The output template is machine-keyed, not human-readable: the filename is the
 * video id and nothing else. YouTube ids are [A-Za-z0-9_-]{11}, so there is
 * nothing to sanitize -- no title length limits, no NAS-hostile characters, no
 * brackets in a title colliding with our own delimiters. The DB carries the
 * title and uploader, so it is the human index; the filesystem is just storage.
 *
 * The `yt-` prefix exists because a YouTube id may legitimately START with a
 * hyphen (two in the current playlist do), and a leading-dash filename is read
 * as a flag by most CLI tools.
 *
 * Because the path is derivable from the id alone, a file already on disk but
 * missing from the DB is self-healing: yt-dlp finds it, skips the download, and
 * the row is created pointing at the existing file.
 *
 * Everything lands FLAT under a single `youtube/` folder so ingest output stays
 * out of the media root next to wake-photos/booth-photos.
 *
 * @public - exported for unit testing so tests can mock the subprocess
 */
export async function ytdlpDownload(
  videoId: string,
  storageDir: string,
  signal: AbortSignal,
): Promise<{
  videoPath: string;
  thumbPath: string | null;
  title: string | null;
  uploader: string | null;
  durationSec: number | null;
}> {
  const output = `${storageDir}/youtube/yt-%(id)s.%(ext)s`;

  const { stdout } = await execFileAsync(
    "yt-dlp",
    [
      // Best stream up to 4K, merged with the best audio. YouTube serves DASH
      // above 360p, so video and audio arrive separately and the `+` makes
      // ffmpeg mux them -- a stream copy, never a re-encode.
      "-f",
      "bv*[height<=2160]+ba/b[height<=2160]",
      // Sort by resolution first, then prefer AV1 at equal resolution: we take
      // AV1's better compression only when it does not cost picture quality.
      "-S",
      "res,vcodec:av01",
      "-N",
      "4", // concurrent DASH fragments -- the real throughput lever
      "--write-thumbnail",
      "--output",
      output,
      // One tab-delimited line: the path yt-dlp actually wrote, plus the
      // metadata we persist. Reading it here avoids a second network round-trip
      // just to fetch the duration back. Tabs do not occur in YouTube titles.
      "--print",
      "after_move:%(filepath)s\t%(title)s\t%(uploader)s\t%(duration)s",
      "--no-simulate",
      "--quiet",
      "--no-warnings",
      `https://www.youtube.com/watch?v=${videoId}`,
    ],
    { signal },
  );

  const line = stdout.trim().split("\n").filter(Boolean).pop();
  const [videoPath, title, uploader, duration] = (line ?? "").split("\t");
  if (!videoPath) {
    throw new Error(`yt-dlp reported no output path for ${videoId}`);
  }
  if (!existsSync(videoPath)) {
    throw new Error(`yt-dlp reported a path that does not exist: ${videoPath}`);
  }

  return {
    videoPath,
    thumbPath: findThumbnailFor(videoPath),
    title: printedField(title),
    uploader: printedField(uploader),
    durationSec: printedDuration(duration),
  };
}

/**
 * yt-dlp prints the literal string "NA" for a field it cannot resolve, so an
 * absent value arrives as text rather than an empty column.
 */
function printedField(value: string | undefined): string | null {
  if (!value || value === "NA") return null;
  return value;
}

/** Parse the printed duration (seconds, possibly "NA") into whole seconds. */
function printedDuration(value: string | undefined): number | null {
  const raw = printedField(value);
  if (raw === null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.round(seconds) : null;
}

/**
 * Locate the thumbnail yt-dlp wrote alongside the video. --write-thumbnail uses
 * the same stem as the video file, so we look for that stem with an image
 * extension rather than globbing the whole directory.
 */
function findThumbnailFor(videoPath: string): string | null {
  const stem = videoPath.replace(/\.[^./]+$/, "");
  for (const ext of [".jpg", ".jpeg", ".png", ".webp"]) {
    if (existsSync(`${stem}${ext}`)) return `${stem}${ext}`;
  }
  return null;
}

/** Read file size in bytes; returns null if the file doesn't exist. */
function fileSizeBytes(path: string | null): number | null {
  if (!path) return null;
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * The actual youtube_ingest job handler, exported as runYoutubeIngest below.
 * Idempotent: exits early if the item is already 'ready'.
 *
 * The signal is threaded into every yt-dlp subprocess so a job that exceeds its
 * maxMs kills the download rather than leaving it running past the row's death.
 */
async function handleYoutubeIngest(rawPayload: unknown, signal: AbortSignal): Promise<void> {
  const payload = rawPayload as YoutubeIngestPayload;
  const { mediaItemId, videoId } = payload;

  // Load the item to check current state.
  const rows = await db.select().from(mediaItem).where(eq(mediaItem.id, mediaItemId)).limit(1);
  const item = rows[0];
  if (!item) {
    getLogger().error({ mediaItemId }, "media_item not found");
    throw new Error(`media_item not found: ${mediaItemId}`);
  }

  // Idempotency: if already complete, skip.
  if (item.status === "ready") {
    getLogger().info({ mediaItemId, videoId }, "youtube_ingest skipped , already ready");
    return;
  }

  // Disk-space check is performed by the youtube_ingest JobSpec wrapper in the
  // worker app, before this handler is entered. Keeping it there rather than on
  // the shared cycle means a full NAS stops downloads without stopping `notify`.

  const storageDir = config.MEDIA_STORAGE_DIR;

  const downloadStart = performance.now();
  getLogger().info({ videoId }, "yt-dlp download start");
  const { videoPath, thumbPath, title, uploader, durationSec } = await ytdlpDownload(
    videoId,
    storageDir,
    signal,
  );
  const downloadMs = +(performance.now() - downloadStart).toFixed(1);

  const videoBytes = fileSizeBytes(videoPath);
  getLogger().info(
    { videoId, videoPath, videoBytes, durationMs: downloadMs },
    "yt-dlp download complete",
  );

  // Mark as ready and persist file + human metadata. rawTitle is NOT NULL and
  // the poller already seeded it from the playlist listing, so only overwrite
  // it when the download reported an authoritative title.
  await db
    .update(mediaItem)
    .set({
      status: "ready",
      videoPath,
      thumbPath: thumbPath ?? null,
      videoBytes: videoBytes ?? null,
      durationSec,
      uploader,
      ...(title === null ? {} : { rawTitle: title }),
      updatedAt: new Date(),
    })
    .where(eq(mediaItem.id, mediaItemId));
}

/** The youtube_ingest job handler. Wired at the worker entrypoint. */
export const runYoutubeIngest: JobHandler = async (rawPayload, signal) => {
  await handleYoutubeIngest(rawPayload, signal);
};
