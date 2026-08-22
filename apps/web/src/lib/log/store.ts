/**
 * Durable log history , IndexedDB.
 *
 * Why this exists at all: the native kiosk shell (web/ios/App/App) runs a
 * KioskWatchdog that reloads the webview when the dashboard stops responding.
 * Every failure the panel already automates around therefore destroys the
 * in-memory ring. Without a persistent layer the logs would be systematically
 * empty for exactly the incidents worth reading about.
 *
 * Written with the raw IndexedDB API rather than a wrapper: the surface we need
 * is four operations, and the web bundle ships to a wall panel where a new
 * runtime dependency has to earn its place.
 *
 * Rotation evicts on BOTH entry count and total bytes, whichever trips first.
 * Count-only eviction is how you discover the disk filled up, because a single
 * fat payload can be thousands of times larger than a typical line. `bytes` is
 * carried per record and the running total is kept in a meta record written in
 * the SAME transaction as every append/prune, so the two cannot drift apart
 * across a crash.
 *
 * Storage durability caveat: the Capacitor shell loads REMOTE content
 * (capacitor.config.ts `server.url` -> the hosted dashboard) rather than a
 * bundled local scheme, so the WKWebView origin is an ordinary https origin and
 * WebKit's 7-day cap on script-writable storage applies to it. Daily use of the
 * panel keeps resetting that clock, and requestPersistence() asks WebKit to
 * exempt us outright, but neither is a guarantee. The backstop is native.ts:
 * every flush also appends to a native JSONL mirror through the Capacitor
 * bridge (which ITP does not touch), and boot restores from it when this store
 * comes up evicted.
 */

import { getDeviceName } from "../device-name";
import { fuzzyMatch } from "./fuzzy";
import type { LogEntry, LogLevel } from "./types";

const DB_NAME = "cc-logs";
// v2: re-keyed from the per-session `seq` to the boot-scoped `id` (a v1 store
// overwrote its own history on every reload).
// v3: entries carry `sha` (was `build`). The upgrade drops and rebuilds either
// way , these are debug logs, and carrying a legacy field forward through the
// render path forever is a worse trade than losing a day of them once.
// v4: entries carry `deviceName`. Unlike earlier steps this one PRESERVES the
// existing store and backfills the missing field (the store is per-device, so
// every existing row was produced by this device , see onupgradeneeded).
const DB_VERSION = 4;
const ENTRIES = "entries";
const META = "meta";
const META_KEY = "stats";

/**
 * Hard caps. Whichever trips first drives eviction.
 *
 * These are ceilings, not reservations , the store only grows to what is
 * actually logged. requestPersistence() is best-effort and the production
 * WKWebView currently denies it, which is why the native mirror remains the
 * durable backstop rather than relying on IndexedDB surviving indefinitely.
 *
 * The server already retains shipped logs for 30 days and the native mirror
 * keeps the recent disaster-recovery tail. The IndexedDB copy is deliberately
 * small enough that maintaining it cannot become a material workload on the
 * always-on iPad. append() still handles QuotaExceededError by evicting hard and
 * retrying, because device storage pressure can lower WebKit's quota at runtime.
 */
export const MAX_ENTRIES = 100_000;
export const MAX_BYTES = 64 * 1024 * 1024;

/** Evict in chunks so a single append doesn't walk the whole store. */
const PRUNE_SLACK = 5_000;

// Live caps. Indirected through a mutable object purely so tests can exercise
// eviction without writing an actual gigabyte to prove a cap works.
let caps = { entries: MAX_ENTRIES, bytes: MAX_BYTES };

/** Test seam: shrink the caps so eviction is reachable in a unit test. */
export function setCapsForTests(next: Partial<typeof caps>): void {
  caps = { ...caps, ...next };
}

/** Test seam: restore the production caps. */
export function resetCapsForTests(): void {
  caps = { entries: MAX_ENTRIES, bytes: MAX_BYTES };
}

interface Stats {
  bytes: number;
}

export interface LogQuery {
  /**
   * Levels to include. Omit for all. This is a SET, not a floor: the viewer's
   * chips toggle levels independently, so "warn + error, but not info" is a
   * thing you can ask for , which a minimum-level threshold cannot express.
   */
  levels?: LogLevel[];
  /** Exact source match. Omit for all sources. */
  source?: string;
  /** Fuzzy match (see fuzzy.ts) against msg + source + serialized data. */
  search?: string;
  /** Page backwards: return entries older than this entry id (newest-first). */
  before?: string;
  /**
   * Page forwards: return entries with id STRICTLY GREATER than this one, in
   * ASCENDING id (== insertion) order, oldest-first. This is the log shipper's
   * read , it walks from its last-shipped cursor toward the newest entry.
   *
   * Mutually exclusive with `before`: the two name opposite directions, so
   * passing both is a caller bug and query() throws rather than silently pick one.
   */
  after?: string;
  /** Max entries to return. Defaults to 200. */
  limit?: number;
}

// A failed open (private mode, quota, corrupt db) must never take the app down:
// logging is the diagnostic layer, not a feature. We degrade to ring-only and
// remember the failure so we don't retry on every flush.
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;
      const hasEntries = db.objectStoreNames.contains(ENTRIES);

      // v1/v2 were keyed the old way (per-session `seq`, legacy `build` field);
      // a fresh install has no store at all. In both cases (re)build clean ,
      // there is nothing worth preserving, and carrying a v1 keyPath forward
      // would silently reinstate the overwrite-on-reload bug (see types.ts).
      if (oldVersion < 3 || !hasEntries) {
        if (hasEntries) db.deleteObjectStore(ENTRIES);
        // keyPath "id" = "<bootMs>-<counter>", fixed-width and zero-padded, so
        // lexicographic key order IS insertion order across reloads.
        const store = db.createObjectStore(ENTRIES, { keyPath: "id" });
        store.createIndex("ts", "ts");
        store.createIndex("level", "level");
      } else {
        // v3 → v4: the store is already correctly keyed. Requirement: existing
        // logs must be UPDATED, not lost. Walk the store inside this
        // versionchange transaction and backfill `deviceName` on any row lacking
        // it. The store is per-device, so `getDeviceName()` (read synchronously
        // from localStorage , safe on the main thread here) is the honest name
        // for every one of these rows.
        const tx = req.transaction;
        if (tx) {
          const store = tx.objectStore(ENTRIES);
          const deviceName = getDeviceName();
          const cursorReq = store.openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) return;
            const value = cursor.value as LogEntry;
            if (!value.deviceName) cursor.update({ ...value, deviceName });
            cursor.continue();
          };
        }
      }

      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Approximate on-disk cost of an entry. Cheap and good enough to drive eviction. */
function entryBytes(entry: LogEntry): number {
  let n = 64; // seq/ts/level/flags overhead
  n += entry.source.length * 2;
  n += entry.msg.length * 2;
  if (entry.data !== undefined) {
    try {
      n += JSON.stringify(entry.data).length * 2;
    } catch {
      n += 256;
    }
  }
  return n;
}

/**
 * Ask the browser to exempt our origin from storage eviction. WebKit grants this
 * heuristically and may simply say no, hence best-effort , see the ITP note at
 * the top of this file.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * Append a batch. Rotation runs in the same transaction, so the caps always hold.
 *
 * On QuotaExceededError we drop the oldest half of the store and retry once. The
 * caps are our own accounting; the QUOTA is the browser's, it is smaller than we
 * think on iPadOS, and it can shrink under device storage pressure without
 * warning. Treating a quota error as fatal would mean the logger quietly stops
 * recording on exactly the day the panel is unhealthy , which is the one failure
 * this whole subsystem exists to prevent.
 */
export async function append(entries: LogEntry[]): Promise<void> {
  try {
    await appendOnce(entries);
  } catch (err) {
    if (!isQuotaError(err)) throw err;
    await evictFraction(0.5);
    await appendOnce(entries);
  }
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "QuotaExceededError" || err.code === 22);
}

/** Drop the oldest `fraction` of entries, recomputing the byte total as we go. */
async function evictFraction(fraction: number): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const total = await count();
  const target = Math.floor(total * fraction);
  if (target <= 0) return;

  const tx = db.transaction([ENTRIES, META], "readwrite");
  const store = tx.objectStore(ENTRIES);
  let removed = 0;
  let freed = 0;

  await new Promise<void>((resolve, reject) => {
    const cursorReq = store.openCursor();
    cursorReq.onerror = () => reject(cursorReq.error);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || removed >= target) {
        resolve();
        return;
      }
      freed += entryBytes(cursor.value as LogEntry);
      removed += 1;
      cursor.delete();
      cursor.continue();
    };
  });

  const meta = tx.objectStore(META);
  const stats = ((await promisify(meta.get(META_KEY))) as Stats | undefined) ?? { bytes: 0 };
  meta.put({ bytes: Math.max(0, stats.bytes - freed) } satisfies Stats, META_KEY);
  await txDone(tx);
}

async function appendOnce(entries: LogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDb();
  if (!db) return;

  const tx = db.transaction([ENTRIES, META], "readwrite");
  const store = tx.objectStore(ENTRIES);
  const meta = tx.objectStore(META);

  const stats = ((await promisify(meta.get(META_KEY))) as Stats | undefined) ?? { bytes: 0 };
  let bytes = stats.bytes;

  for (const entry of entries) {
    store.put(entry);
    bytes += entryBytes(entry);
  }

  let count = await promisify(store.count());

  // Evict oldest-first until both caps hold. Cursor order == seq order ==
  // insertion order, so "oldest" is simply the front of the store.
  if (count > caps.entries || bytes > caps.bytes) {
    const targetCount = Math.max(0, caps.entries - Math.min(PRUNE_SLACK, caps.entries / 10));
    const targetBytes = caps.bytes * 0.9;
    await new Promise<void>((resolve, reject) => {
      const cursorReq = store.openCursor();
      cursorReq.onerror = () => reject(cursorReq.error);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (count <= targetCount && bytes <= targetBytes) {
          resolve();
          return;
        }
        bytes -= entryBytes(cursor.value as LogEntry);
        count -= 1;
        cursor.delete();
        cursor.continue();
      };
    });
  }

  meta.put({ bytes: Math.max(0, bytes) } satisfies Stats, META_KEY);
  await txDone(tx);
}

function matches(entry: LogEntry, q: LogQuery): boolean {
  if (q.levels && !q.levels.includes(entry.level)) return false;
  if (q.source && entry.source !== q.source) return false;
  if (q.search) {
    // Match against the whole line as one haystack, so a query can span the
    // message, its payload ("tesla 503") and the device name the way it reads on
    // screen.
    let haystack = `${entry.source} ${entry.msg} ${entry.deviceName ?? ""}`;
    if (entry.data !== undefined) {
      try {
        haystack += ` ${JSON.stringify(entry.data)}`;
      } catch {
        // non-serializable data just isn't searchable
      }
    }
    return fuzzyMatch(haystack, q.search);
  }
  return true;
}

/**
 * Page through history, applying filters while walking the cursor so we never
 * materialize 100k entries to throw most away.
 *
 * Direction is set by the cursor id given: `after` pages FORWARD (ascending id,
 * oldest-first) for the shipper draining its backlog; `before` (and the default)
 * pages BACKWARD (descending id, newest-first) for the viewer. Both are a plain
 * key range on the primary key , ids are `${bootMs}-${seq}`, zero-padded, so
 * lexicographic order is insertion order.
 */
export async function query(q: LogQuery = {}): Promise<LogEntry[]> {
  if (q.before !== undefined && q.after !== undefined) {
    throw new Error("log query: `before` and `after` are mutually exclusive");
  }
  const db = await openDb();
  if (!db) return [];
  const limit = q.limit ?? 200;

  const [range, direction]: [IDBKeyRange | null, IDBCursorDirection] =
    q.after !== undefined
      ? [IDBKeyRange.lowerBound(q.after, /* open */ true), "next"]
      : [q.before !== undefined ? IDBKeyRange.upperBound(q.before, /* open */ true) : null, "prev"];

  const tx = db.transaction(ENTRIES, "readonly");
  const store = tx.objectStore(ENTRIES);

  return new Promise<LogEntry[]>((resolve, reject) => {
    const out: LogEntry[] = [];
    const cursorReq = store.openCursor(range, direction);
    cursorReq.onerror = () => reject(cursorReq.error);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || out.length >= limit) {
        resolve(out);
        return;
      }
      const entry = cursor.value as LogEntry;
      if (matches(entry, q)) out.push(entry);
      cursor.continue();
    };
  });
}

export interface LogSummary {
  /** Total entries per level since the cutoff. */
  counts: Record<LogLevel, number>;
  /**
   * Per-level counts in `bucketCount` equal time slices from the cutoff to
   * `now`, oldest first. An entry's slice is floor((ts - since) / bucketMs).
   */
  buckets: Array<Record<LogLevel, number>>;
}

function emptyTally(): Record<LogLevel, number> {
  return { debug: 0, info: 0, warn: 0, error: 0 };
}

/**
 * Tally recent history by level, sliced into time buckets , the Frontend Logs
 * tile's whole data need in one cursor walk.
 *
 * Walks newest-first and STOPS at the first entry older than `since`: ids are
 * `${bootMs}-${seq}` so insertion order is time order per boot, and the tile
 * asks about the last 24h of a store that may hold weeks , walking only the
 * recent slice instead of materializing (or even visiting) a million rows is
 * the point of doing this in the store rather than over query()'s results.
 * A clock skew across boots can hide at most the skewed sliver; the tile is a
 * glanceable tally, not an audit.
 */
export async function summarizeSince(
  since: number,
  now: number,
  bucketCount: number,
): Promise<LogSummary> {
  const counts = emptyTally();
  const buckets = Array.from({ length: bucketCount }, emptyTally);
  const db = await openDb();
  if (!db) return { counts, buckets };
  const bucketMs = Math.max(1, (now - since) / bucketCount);

  const tx = db.transaction(ENTRIES, "readonly");
  const entries = tx.objectStore(ENTRIES);

  return new Promise<LogSummary>((resolve, reject) => {
    const cursorReq = entries.openCursor(null, "prev");
    cursorReq.onerror = () => reject(cursorReq.error);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        resolve({ counts, buckets });
        return;
      }
      const entry = cursor.value as LogEntry;
      if (entry.ts < since) {
        resolve({ counts, buckets });
        return;
      }
      counts[entry.level] += 1;
      const slot = Math.min(bucketCount - 1, Math.floor((entry.ts - since) / bucketMs));
      buckets[slot][entry.level] += 1;
      cursor.continue();
    };
  });
}

/**
 * Bytes currently held on disk, per the running total maintained alongside every
 * append and prune. Approximate by construction (see entryBytes), but it is the
 * SAME number that drives eviction , so what the viewer shows is what the cap is
 * actually measured against, rather than a second, prettier estimate that could
 * disagree with it.
 */
export async function bytesUsed(): Promise<number> {
  const db = await openDb();
  if (!db) return 0;
  const tx = db.transaction(META, "readonly");
  const stats = (await promisify(tx.objectStore(META).get(META_KEY))) as Stats | undefined;
  return stats?.bytes ?? 0;
}

/**
 * Exact entry count across the given levels, via the `level` index , O(levels)
 * index counts, no cursor walk. This is the denominator for the filtered
 * export's progress bar: the export needs to promise "n of m" before it starts
 * paging, and estimating m from the unfiltered total would make the bar lie.
 */
export async function countByLevels(levels: LogLevel[]): Promise<number> {
  const db = await openDb();
  if (!db) return 0;
  const tx = db.transaction(ENTRIES, "readonly");
  const index = tx.objectStore(ENTRIES).index("level");
  const counts = await Promise.all(
    levels.map((level) => promisify(index.count(IDBKeyRange.only(level)))),
  );
  return counts.reduce((sum, n) => sum + n, 0);
}

/** Entry count. Used by the viewer's footer and by tests. */
export async function count(): Promise<number> {
  const db = await openDb();
  if (!db) return 0;
  const tx = db.transaction(ENTRIES, "readonly");
  return promisify(tx.objectStore(ENTRIES).count());
}

/** Drop all history. Exposed in the viewer so a panel can be reset in the field. */
export async function clear(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction([ENTRIES, META], "readwrite");
  tx.objectStore(ENTRIES).clear();
  tx.objectStore(META).put({ bytes: 0 } satisfies Stats, META_KEY);
  await txDone(tx);
}

/** Test seam: forget the cached handle so a fresh fake-indexeddb can be opened. */
export function resetForTests(): void {
  dbPromise = null;
}
