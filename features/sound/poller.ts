/**
 * Playlist-poller service (www-kp4k.3). Each cycle:
 *   1. Fetches all enabled media_source rows.
 *   2. For every enabled source that resolves to a URL (regardless of kind), runs
 *      `yt-dlp --flat-playlist` to enumerate video IDs and titles without
 *      downloading any content.
 *   3. For each video ID not already in media_item, inserts a new media_item
 *      (status=queued, titled from the listing) and enqueues a `youtube_ingest` job.
 *
 * Idempotency: the uniqueIndex on media_item.yt_video_id means a re-poll of the
 * same playlist is a no-op , the INSERT … ON CONFLICT DO NOTHING ensures we never
 * create duplicate items, and we never re-enqueue a job for an existing item.
 *
 * yt-dlp is the subprocess binary installed in the worker Dockerfile.
 * In unit tests the spawn is mocked at the module boundary.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { enqueueJob } from "@www/core";
import { getLogger } from "@www/logger";
import { eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { mediaItem, mediaSource } from "./schema";

const execFileAsync = promisify(execFile);

/** One entry from a playlist listing: enough to create a useful row. */
export interface PlaylistEntry {
  id: string;
  title: string;
}

/**
 * Spawn yt-dlp for a single playlist URL and collect the entries it prints, one
 * tab-delimited `id<TAB>title` per line. The title costs nothing extra in
 * --flat-playlist mode and means a media_item row carries a real label from the
 * moment it is discovered, rather than waiting for the download to name it.
 *
 * @public , exported for unit testing (allows the test to swap ytdlpListPlaylist)
 */
export async function ytdlpListPlaylist(url: string): Promise<PlaylistEntry[]> {
  const { stdout } = await execFileAsync("yt-dlp", [
    "--flat-playlist",
    "--print",
    "%(id)s\t%(title)s",
    // Quiet: suppress progress bars and info lines; we only want our own lines.
    "--quiet",
    "--no-warnings",
    url,
  ]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, title] = line.split("\t");
      return { id: id ?? "", title: title || (id ?? "") };
    })
    .filter((entry) => entry.id !== "");
}

/** Stripe-style id generator for new media_item rows. */
function newMediaItemId(): string {
  const hex = Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `mi_${hex}`;
}

/**
 * One poll cycle. Called by the playlist-poller Worker every ~10 minutes.
 * Throws on DB errors so the runtime records a consecutive-failure streak;
 * individual yt-dlp subprocess failures are caught + logged per-source so
 * one bad playlist doesn't stall the others.
 */
export async function runPlaylistPollerCycle(
  // Dependency-injection hook so unit tests can replace the subprocess call.
  listFn: typeof ytdlpListPlaylist = ytdlpListPlaylist,
): Promise<void> {
  // Only poll sources that are enabled and have a known playlist URL.
  const sources = await db.select().from(mediaSource).where(eq(mediaSource.enabled, true));

  for (const source of sources) {
    const url = source.url ?? (source.externalId ? buildPlaylistUrl(source.externalId) : null);
    if (!url) continue;

    let entries: PlaylistEntry[];
    try {
      entries = await listFn(url);
    } catch (err) {
      // Log and continue , a single broken source must not stall the rest.
      getLogger().warn({ err, sourceId: source.id }, "yt-dlp failed for source");
      continue;
    }

    if (entries.length === 0) {
      getLogger().info({ sourceId: source.id }, "playlist empty");
      continue;
    }

    // Fetch already-known IDs in one query to avoid per-item round-trips.
    const existing = await db
      .select({ ytVideoId: mediaItem.ytVideoId })
      .from(mediaItem)
      .where(
        inArray(
          mediaItem.ytVideoId,
          entries.map((e) => e.id),
        ),
      );
    const existingSet = new Set(existing.map((r) => r.ytVideoId));

    const newEntries = entries.filter((e) => !existingSet.has(e.id));
    // Cycle summary: log once per source so operators can see poll progress.
    getLogger().info(
      { sourceId: source.id, found: entries.length, newCount: newEntries.length },
      "playlist polled",
    );
    if (newEntries.length > 0) {
      getLogger().info(
        { sourceId: source.id, newCount: newEntries.length, videoIds: newEntries.map((e) => e.id) },
        "new playlist items discovered",
      );
    }
    for (const { id: videoId, title } of newEntries) {
      // Insert the media_item row. ON CONFLICT DO NOTHING makes this safe even
      // if two poller instances race (the unique index on yt_video_id wins).
      const rows = await db
        .insert(mediaItem)
        .values({
          id: newMediaItemId(),
          sourceId: source.id,
          ytVideoId: videoId,
          // Real title from the playlist listing; the ingest handler replaces it
          // with the authoritative one once the download reports it.
          rawTitle: title,
          status: "queued",
        })
        .onConflictDoNothing()
        .returning({ id: mediaItem.id });

      // Only enqueue if we actually inserted a new row (not a conflict).
      if (rows.length > 0 && rows[0]) {
        await enqueueJob(db, "youtube_ingest", {
          mediaItemId: rows[0].id,
          videoId,
        });
      }
    }
  }
}

/** Build the YouTube playlist URL from a playlist ID. */
function buildPlaylistUrl(playlistId: string): string {
  return `https://www.youtube.com/playlist?list=${playlistId}`;
}
