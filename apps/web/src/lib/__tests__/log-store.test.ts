import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import * as store from "../log/store";
import type { LogEntry, LogLevel } from "../log/types";

/** Same fixed-width, sortable shape the logger emits: `${bootMs}-${seq}`. */
function id(seq: number, boot = 1): string {
  return `${String(boot).padStart(14, "0")}-${String(seq).padStart(8, "0")}`;
}

function entry(seq: number, over: Partial<LogEntry> = {}): LogEntry {
  return {
    id: id(seq),
    seq,
    ts: 1_700_000_000_000 + seq,
    sha: "abc1234",
    deviceName: "test-device",
    level: "info",
    source: "test",
    msg: `message ${seq}`,
    ...over,
  };
}

beforeEach(() => {
  // Fresh database per test; store.ts caches the open handle, so drop that too.
  globalThis.indexedDB = new IDBFactory();
  store.resetForTests();
  store.resetCapsForTests();
});

describe("log store", () => {
  it("appends and reads back newest-first", async () => {
    await store.append([entry(1), entry(2), entry(3)]);
    const rows = await store.query();
    expect(rows.map((r) => r.seq)).toEqual([3, 2, 1]);
    expect(await store.count()).toBe(3);
  });

  it("pages backwards with `before`", async () => {
    await store.append([entry(1), entry(2), entry(3), entry(4)]);
    const page = await store.query({ before: id(3) });
    expect(page.map((r) => r.seq)).toEqual([2, 1]);
  });

  describe("`after` (ascending forward paging, the shipper's read)", () => {
    it("returns entries strictly after the id, in ascending order", async () => {
      await store.append([entry(1), entry(2), entry(3), entry(4)]);
      // Strictly greater: id(2) itself is excluded; oldest-first from there.
      expect((await store.query({ after: id(2) })).map((r) => r.seq)).toEqual([3, 4]);
    });

    it("returns the whole store ascending when the cursor predates everything", async () => {
      await store.append([entry(1), entry(2), entry(3)]);
      // A lost/empty cursor re-ships from the start , ascending across all rows.
      expect((await store.query({ after: id(0) })).map((r) => r.seq)).toEqual([1, 2, 3]);
    });

    it("returns nothing once the cursor is at the newest entry", async () => {
      await store.append([entry(1), entry(2)]);
      expect(await store.query({ after: id(2) })).toEqual([]);
    });

    it("honours the limit while paging forward (batch cap)", async () => {
      await store.append(Array.from({ length: 20 }, (_, i) => entry(i + 1)));
      const page = await store.query({ after: id(0), limit: 5 });
      expect(page.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    });

    it("applies level filters while paging forward", async () => {
      await store.append([
        entry(1, { level: "debug" }),
        entry(2, { level: "error" }),
        entry(3, { level: "info" }),
        entry(4, { level: "error" }),
      ]);
      expect((await store.query({ after: id(0), levels: ["error"] })).map((r) => r.seq)).toEqual([
        2, 4,
      ]);
    });

    it("rejects `before` and `after` together (opposite directions)", async () => {
      await expect(store.query({ before: id(3), after: id(1) })).rejects.toThrow(
        /mutually exclusive/,
      );
    });
  });

  it("filters by an arbitrary SET of levels, not a threshold", async () => {
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    await store.append(levels.map((level, i) => entry(i, { level })));

    expect((await store.query({ levels: ["warn", "error"] })).map((r) => r.level).sort()).toEqual([
      "error",
      "warn",
    ]);

    // The point of a set over a "minimum level": on a polling dashboard the debug
    // firehose is what you want off while still seeing info. A threshold cannot
    // express that.
    expect(
      (await store.query({ levels: ["info", "warn", "error"] })).map((r) => r.level).sort(),
    ).toEqual(["error", "info", "warn"]);
  });

  it("counts exactly by level set via the level index", async () => {
    await store.append([
      entry(1, { level: "debug" }),
      entry(2, { level: "debug" }),
      entry(3, { level: "info" }),
      entry(4, { level: "warn" }),
      entry(5, { level: "error" }),
    ]);
    expect(await store.countByLevels(["error"])).toBe(1);
    expect(await store.countByLevels(["warn", "error"])).toBe(2);
    expect(await store.countByLevels(["debug", "info", "warn", "error"])).toBe(5);
    expect(await store.countByLevels([])).toBe(0);
  });

  it("filters by source", async () => {
    await store.append([entry(1, { source: "trpc" }), entry(2, { source: "tile:weather" })]);
    const rows = await store.query({ source: "trpc" });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("trpc");
  });

  it("searches message, source and serialized data", async () => {
    await store.append([
      entry(1, { msg: "connection lost" }),
      entry(2, { msg: "all good", data: { httpStatus: 502 } }),
      entry(3, { msg: "unrelated" }),
    ]);
    expect((await store.query({ search: "connection" })).map((r) => r.seq)).toEqual([1]);
    expect((await store.query({ search: "502" })).map((r) => r.seq)).toEqual([2]);
  });

  it("searches the device name too", async () => {
    await store.append([
      entry(1, { deviceName: "kitchen-ipad" }),
      entry(2, { deviceName: "office-laptop" }),
    ]);
    expect((await store.query({ search: "kitchen" })).map((r) => r.seq)).toEqual([1]);
    expect((await store.query({ search: "laptop" })).map((r) => r.seq)).toEqual([2]);
  });

  it("honours the limit", async () => {
    await store.append(Array.from({ length: 20 }, (_, i) => entry(i)));
    expect(await store.query({ limit: 5 })).toHaveLength(5);
  });

  it("clears", async () => {
    await store.append([entry(1)]);
    await store.clear();
    expect(await store.count()).toBe(0);
  });

  describe("summarizeSince", () => {
    const T0 = 1_700_000_000_000;

    it("tallies levels and slices them into time buckets, oldest first", async () => {
      await store.append([
        entry(1, { ts: T0 + 1_000, level: "error" }), // bucket 0
        entry(2, { ts: T0 + 1_500, level: "warn" }), // bucket 0
        entry(3, { ts: T0 + 5_000, level: "info" }), // bucket 1
        entry(4, { ts: T0 + 9_000, level: "error" }), // bucket 2
      ]);
      const summary = await store.summarizeSince(T0, T0 + 12_000, 3);
      expect(summary.counts).toEqual({ debug: 0, info: 1, warn: 1, error: 2 });
      expect(summary.buckets.map((b) => b.error)).toEqual([1, 0, 1]);
      expect(summary.buckets.map((b) => b.warn)).toEqual([1, 0, 0]);
      expect(summary.buckets.map((b) => b.info)).toEqual([0, 1, 0]);
    });

    it("excludes entries older than the cutoff", async () => {
      await store.append([
        entry(1, { ts: T0 - 5_000, level: "error" }),
        entry(2, { ts: T0 + 5_000, level: "warn" }),
      ]);
      const summary = await store.summarizeSince(T0, T0 + 10_000, 2);
      expect(summary.counts.error).toBe(0);
      expect(summary.counts.warn).toBe(1);
    });

    it("clamps an entry stamped at/after `now` into the last bucket", async () => {
      await store.append([entry(1, { ts: T0 + 10_000, level: "error" })]);
      const summary = await store.summarizeSince(T0, T0 + 10_000, 4);
      expect(summary.buckets[3].error).toBe(1);
    });

    it("returns an all-zero summary when IndexedDB is unavailable", async () => {
      // @ts-expect-error deliberately removing the global
      globalThis.indexedDB = undefined;
      store.resetForTests();
      const summary = await store.summarizeSince(T0, T0 + 1_000, 2);
      expect(summary.counts).toEqual({ debug: 0, info: 0, warn: 0, error: 0 });
      expect(summary.buckets).toHaveLength(2);
    });
  });

  it("evicts oldest-first when the byte cap is exceeded", async () => {
    // Eviction is driven by BYTES, not just count: one fat payload can be
    // thousands of times larger than a typical line, so a count-only policy is
    // how you discover the disk filled up. Caps are shrunk here rather than
    // writing an actual gigabyte to prove the same thing.
    store.setCapsForTests({ entries: 1_000_000, bytes: 8 * 1024 * 1024 });

    const fat = "x".repeat(400_000);
    const entries = Array.from({ length: 80 }, (_, i) => entry(i, { data: { blob: fat } }));
    await store.append(entries);

    const remaining = await store.count();
    expect(remaining).toBeLessThan(entries.length);
    expect(remaining).toBeGreaterThan(0);

    // Whatever survived must be the NEWEST entries , the oldest are the ones
    // you no longer care about.
    const rows = await store.query({ limit: 1 });
    expect(rows[0].seq).toBe(79);
    const all = await store.query({ limit: 1_000 });
    const seqs = all.map((r) => r.seq);
    expect(Math.min(...seqs)).toBeGreaterThan(0);
  });

  it("keeps history from previous page loads instead of overwriting it", async () => {
    // THE regression test for this feature. Entry ids embed the boot timestamp,
    // so a reload starts a fresh `seq` at 0 WITHOUT colliding with the previous
    // session's rows. Keying the store on `seq` alone (as the first cut did)
    // meant every reload silently overwrote the last session's entries row for
    // row , and the kiosk watchdog reloads the webview on failure, so the only
    // history ever destroyed would be the history of the incident.
    const firstBoot = [
      { ...entry(0, { msg: "app start" }), id: id(0, 1) },
      { ...entry(1, { msg: "climate.get failed", level: "error" as const }), id: id(1, 1) },
    ];
    await store.append(firstBoot);

    // Second page load: seq restarts at 0, boot stamp differs.
    const secondBoot = [{ ...entry(0, { msg: "app start" }), id: id(0, 2) }];
    await store.append(secondBoot);

    expect(await store.count()).toBe(3);

    const rows = await store.query();
    // Newest first, and the pre-reload error is still there to be read.
    expect(rows.map((r) => r.id)).toEqual([id(0, 2), id(1, 1), id(0, 1)]);
    expect(rows.some((r) => r.msg === "climate.get failed")).toBe(true);
  });

  it("rebuilds a v1 database that was keyed on the per-session seq", async () => {
    // A pre-fix dev build left a v1 store keyed on `seq`. Opening it at v2 must
    // drop and rebuild it: writing into the old store would silently reinstate
    // the overwrite-on-reload bug, and a migration that quietly does nothing is
    // the hardest kind to notice.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("cc-logs", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const s = db.createObjectStore("entries", { keyPath: "seq" });
        s.createIndex("ts", "ts");
        s.createIndex("level", "level");
        db.createObjectStore("meta");
      };
      req.onsuccess = () => {
        const db = req.result;
        db.transaction("entries", "readwrite")
          .objectStore("entries")
          .put({ seq: 0, ts: 1, level: "info", source: "stale", msg: "v1 row" });
        db.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });

    store.resetForTests();
    await store.append([entry(0, { msg: "after upgrade" })]);

    const rows = await store.query();
    // The stale v1 row is gone and the store now keys on `id`.
    expect(rows.map((r) => r.msg)).toEqual(["after upgrade"]);
    expect(rows[0].id).toBe(id(0));
  });

  it("resets a v4 cache without restoring the native mirror during the v5 cap migration", async () => {
    // The old production cap allowed one million rows. Seed a v4 store and prove
    // the v5 schema upgrade drops the whole redundant object store rather than
    // making append() cursor-delete every excess record one-by-one.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("cc-logs", 4);
      req.onupgradeneeded = () => {
        const db = req.result;
        const s = db.createObjectStore("entries", { keyPath: "id" });
        s.createIndex("ts", "ts");
        s.createIndex("level", "level");
        db.createObjectStore("meta");
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(["entries", "meta"], "readwrite");
        tx.objectStore("entries").put(entry(1, { msg: "old oversized cache" }));
        tx.objectStore("meta").put({ bytes: 900_000_000 }, "stats");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

    store.resetForTests();
    expect(await store.count()).toBe(0);
    expect(await store.bytesUsed()).toBe(0);
    expect(await store.shouldRestoreFromNative()).toBe(false);

    // The first normal write clears the one-shot marker. A later explicit clear
    // or genuine store eviction is again eligible for native-mirror restore.
    await store.append([entry(2, { msg: "new bounded cache" })]);
    expect((await store.query()).map((row) => row.msg)).toEqual(["new bounded cache"]);
    await store.clear();
    expect(await store.shouldRestoreFromNative()).toBe(true);
  });

  it("allows native restore on a fresh v5 database", async () => {
    // A fresh install is genuinely empty; unlike the intentional cap reset, its
    // native mirror may contain the only surviving incident history.
    expect(await store.count()).toBe(0);
    expect(await store.shouldRestoreFromNative()).toBe(true);
  });

  it("survives a QuotaExceededError by evicting and retrying", async () => {
    // Our caps are our own accounting. The browser's QUOTA is not: on iPadOS it is
    // tighter than we think and can shrink under device storage pressure. If a
    // quota error were fatal the logger would quietly stop recording on exactly
    // the day the panel is unhealthy - the one failure this subsystem exists to
    // prevent. So: drop the oldest half, retry once.
    await store.append(Array.from({ length: 10 }, (_, i) => entry(i)));

    const real = IDBObjectStore.prototype.put;
    let thrown = false;
    IDBObjectStore.prototype.put = function patched(this: IDBObjectStore, ...args: unknown[]) {
      if (!thrown) {
        thrown = true;
        throw new DOMException("quota", "QuotaExceededError");
      }
      return (real as (...a: unknown[]) => IDBRequest).apply(this, args);
    } as typeof real;

    try {
      await store.append([entry(10, { msg: "after quota" })]);
    } finally {
      IDBObjectStore.prototype.put = real;
    }

    expect(thrown).toBe(true);
    // The write landed, and the oldest entries were sacrificed to make room.
    const rows = await store.query({ limit: 1 });
    expect(rows[0].msg).toBe("after quota");
    expect(await store.count()).toBeLessThan(11);
  });

  it("degrades to a no-op when IndexedDB is unavailable", async () => {
    // Private mode / a locked-down webview must not take the app down: logging is
    // the diagnostic layer, not a feature.
    // @ts-expect-error deliberately removing the global
    globalThis.indexedDB = undefined;
    store.resetForTests();
    await expect(store.append([entry(1)])).resolves.toBeUndefined();
    await expect(store.query()).resolves.toEqual([]);
    await expect(store.count()).resolves.toBe(0);
  });
});
