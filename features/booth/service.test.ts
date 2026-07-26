import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type BoothPhotoMeta,
  clearBoothGroupFilter,
  listBoothPhotos,
  readBoothPhoto,
  saveBoothPhoto,
  softDeleteBoothGroup,
} from "./service";

// Minimal valid-enough bodies: the magic-byte prefix each format is sniffed by.
function jpeg(payload = "x"): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, ...new TextEncoder().encode(payload)]);
}
function gif(payload = "x"): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...new TextEncoder().encode(payload)]);
}

// ─── in-memory db harness (mirrors features/wakes/service.test.ts): a plain object
// implementing only the drizzle surface this service calls. `update().where()`
// ignores the (opaque) drizzle predicate and marks every live row, the same
// trust-drizzle-for-the-WHERE convention features/guest-wifi/jobs.test.ts uses; the
// service's own tests populate a single group when that matters. ─────────────

type BoothRow = {
  id: string;
  path: string;
  capturedAt: Date;
  mode: string;
  groupId: string;
  frameIdx: number;
  mimeType: string;
  bytes: number;
  deviceId: string | null;
  filter: string | null;
  sourceOnly: boolean;
  softDeletedAt: Date | null;
};

function createMockDb() {
  const rows: BoothRow[] = [];
  const db = {
    rows,
    insert: (_table: unknown) => ({
      values: (vals: BoothRow) => {
        rows.push(vals);
        return Promise.resolve({ rowCount: 1 });
      },
    }),
    select: (_cols?: unknown) => ({
      from: (_table: unknown) => ({
        orderBy: (_o: unknown) =>
          Promise.resolve(
            [...rows].sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime()),
          ),
      }),
    }),
    update: (_table: unknown) => ({
      // Applies the patch (softDelete stamp OR filter clear) to every live row,
      // ignoring the opaque drizzle predicate; the group-scoped tests populate a
      // single group so the row count is exact.
      set: (patch: Partial<BoothRow>) => ({
        where: (_cond: unknown) => {
          let n = 0;
          for (const r of rows) {
            if (r.softDeletedAt == null) {
              Object.assign(r, patch);
              n++;
            }
          }
          return Promise.resolve({ rowCount: n });
        },
      }),
    }),
  };
  // biome-ignore lint: test harness stands in for NodePgDatabase<typeof schema>
  return db as any;
}

function meta(overrides: Partial<BoothPhotoMeta> = {}): BoothPhotoMeta {
  return {
    capturedAt: Date.UTC(2026, 6, 19, 12, 0, 0),
    mode: "photo",
    groupId: "bpg_group001",
    frameIdx: 0,
    deviceId: "ipad13-1-3f9a2c1b",
    filter: null,
    sourceOnly: false,
    ...overrides,
  };
}

describe("booth-photo-service", () => {
  let root: string;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "booth-photos-test-"));
    db = createMockDb();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("saves a jpeg under a flat ISO-instant path and round-trips through read", async () => {
    const ts = Date.UTC(2026, 6, 19, 12, 0, 0);
    const { id, path } = await saveBoothPhoto(db, jpeg("frame"), meta({ capturedAt: ts }), root);
    expect(id).toMatch(/^bph_[0-9a-f]+$/);
    expect(path).toBe("2026-07-19T12-00-00.000Z-0.jpg");
    const read = await readBoothPhoto(path, root);
    expect(read).not.toBeNull();
    expect([...(read?.bytes ?? [])].slice(0, 3)).toEqual([0xff, 0xd8, 0xff]);
  });

  it("stores a gif with a .gif path and image/gif mime type", async () => {
    const { path } = await saveBoothPhoto(db, gif("anim"), meta({ mode: "gif" }), root);
    expect(path.endsWith(".gif")).toBe(true);
    expect(db.rows[0].mimeType).toBe("image/gif");
    expect(db.rows[0].mode).toBe("gif");
  });

  it("records the row carrying id, group, mode, frame index and device", async () => {
    const ts = Date.UTC(2026, 6, 19, 8, 0, 0);
    const { id, path } = await saveBoothPhoto(
      db,
      jpeg("frame"),
      meta({ capturedAt: ts, mode: "burst", groupId: "bpg_burst01", frameIdx: 2 }),
      root,
    );
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      id,
      path,
      mode: "burst",
      groupId: "bpg_burst01",
      frameIdx: 2,
      mimeType: "image/jpeg",
      deviceId: "ipad13-1-3f9a2c1b",
      bytes: jpeg("frame").length,
      softDeletedAt: null,
    });
    expect(db.rows[0].capturedAt.getTime()).toBe(ts);
  });

  it("stores the bytes even when there is no device to attribute them to", async () => {
    const { path } = await saveBoothPhoto(db, jpeg("x"), meta({ deviceId: null }), root);
    expect(db.rows[0].deviceId).toBeNull();
    expect(await readBoothPhoto(path, root)).not.toBeNull();
  });

  it("suffixes same-timestamp frames instead of overwriting", async () => {
    const ts = Date.UTC(2026, 6, 19, 12, 0, 0);
    const a = await saveBoothPhoto(db, jpeg("a"), meta({ capturedAt: ts, frameIdx: 0 }), root);
    const b = await saveBoothPhoto(db, jpeg("b"), meta({ capturedAt: ts, frameIdx: 1 }), root);
    expect(a.path).not.toEqual(b.path);
    expect(b.path.endsWith("-1.jpg")).toBe(true);
  });

  it("rejects an unknown mode", async () => {
    await expect(
      // biome-ignore lint: deliberately invalid mode
      saveBoothPhoto(db, jpeg(), meta({ mode: "video" as any }), root),
    ).rejects.toThrow(/mode/);
    expect(db.rows).toHaveLength(0);
  });

  it("rejects bytes whose format does not match the mode", async () => {
    await expect(saveBoothPhoto(db, gif(), meta({ mode: "photo" }), root)).rejects.toThrow(/JPEG/);
    await expect(saveBoothPhoto(db, jpeg(), meta({ mode: "gif" }), root)).rejects.toThrow(/GIF/);
    expect(db.rows).toHaveLength(0);
  });

  it("rejects a non-image body", async () => {
    await expect(
      saveBoothPhoto(db, new TextEncoder().encode("plain text"), meta(), root),
    ).rejects.toThrow(/JPEG/);
    expect(db.rows).toHaveLength(0);
  });

  it("rejects oversize bodies", async () => {
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    big.set([0xff, 0xd8, 0xff]);
    await expect(saveBoothPhoto(db, big, meta(), root)).rejects.toThrow(/too large/);
    expect(db.rows).toHaveLength(0);
  });

  it("groups frames of one capture, newest group first, frames by frame index", async () => {
    const older = Date.UTC(2026, 6, 18, 9, 0, 0);
    const newerA = Date.UTC(2026, 6, 19, 8, 0, 0);
    const newerB = Date.UTC(2026, 6, 19, 8, 0, 1);
    await saveBoothPhoto(db, jpeg("solo"), meta({ capturedAt: older, groupId: "bpg_solo" }), root);
    // A burst: two frames, one group, uploaded out of frame order.
    await saveBoothPhoto(
      db,
      jpeg("f1"),
      meta({ capturedAt: newerB, mode: "burst", groupId: "bpg_burst", frameIdx: 1 }),
      root,
    );
    await saveBoothPhoto(
      db,
      jpeg("f0"),
      meta({ capturedAt: newerA, mode: "burst", groupId: "bpg_burst", frameIdx: 0 }),
      root,
    );

    const listing = await listBoothPhotos(db);
    expect(listing.totalCount).toBe(3);
    expect(listing.totalBytes).toBeGreaterThan(0);
    expect(listing.groups.map((g) => g.groupId)).toEqual(["bpg_burst", "bpg_solo"]);
    const burst = listing.groups[0];
    expect(burst.mode).toBe("burst");
    expect(burst.frames.map((f) => f.frameIdx)).toEqual([0, 1]);
    expect(burst.capturedAt).toBe(newerB);
  });

  it("excludes soft-deleted frames from the listing", async () => {
    await saveBoothPhoto(db, jpeg("live"), meta({ groupId: "bpg_live" }), root);
    // A frame removed earlier: bytes still on disk, hidden from every read.
    db.rows.push({
      id: "bph_gone",
      path: "2026-07-19T12-00-00.000Z-0.jpg",
      capturedAt: new Date(Date.UTC(2026, 6, 19, 13, 0, 0)),
      mode: "photo",
      groupId: "bpg_gone",
      frameIdx: 0,
      mimeType: "image/jpeg",
      bytes: 10,
      deviceId: null,
      filter: null,
      sourceOnly: false,
      softDeletedAt: new Date(),
    });

    const listing = await listBoothPhotos(db);
    expect(listing.totalCount).toBe(1);
    expect(listing.groups.map((g) => g.groupId)).toEqual(["bpg_live"]);
  });

  it("empty index lists empty", async () => {
    expect(await listBoothPhotos(db)).toEqual({ groups: [], totalCount: 0, totalBytes: 0 });
  });

  it("soft-deletes a whole group and reports how many frames it removed", async () => {
    await saveBoothPhoto(
      db,
      jpeg("f0"),
      meta({ mode: "burst", groupId: "bpg_del", frameIdx: 0 }),
      root,
    );
    await saveBoothPhoto(
      db,
      jpeg("f1"),
      meta({ mode: "burst", groupId: "bpg_del", frameIdx: 1 }),
      root,
    );

    const { removed } = await softDeleteBoothGroup(db, "bpg_del");
    expect(removed).toBe(2);
    expect(db.rows.every((r: BoothRow) => r.softDeletedAt != null)).toBe(true);
    expect(await listBoothPhotos(db)).toEqual({ groups: [], totalCount: 0, totalBytes: 0 });
  });

  it("stores a valid filter id on the row", async () => {
    await saveBoothPhoto(db, jpeg("f"), meta({ filter: "warm_70s" }), root);
    expect(db.rows[0].filter).toBe("warm_70s");
  });

  it("stores null when no filter is chosen", async () => {
    await saveBoothPhoto(db, jpeg("f"), meta({ filter: null }), root);
    expect(db.rows[0].filter).toBeNull();
  });

  it("rejects a filter id that violates the pattern, writing no row", async () => {
    await expect(
      saveBoothPhoto(db, jpeg("f"), meta({ filter: "Bad Filter!" }), root),
    ).rejects.toThrow(/filter/);
    await expect(
      saveBoothPhoto(db, jpeg("f"), meta({ filter: "x".repeat(33) }), root),
    ).rejects.toThrow(/filter/);
    expect(db.rows).toHaveLength(0);
  });

  it("surfaces the filter on frames and the group in the listing", async () => {
    await saveBoothPhoto(
      db,
      jpeg("f0"),
      meta({ mode: "burst", groupId: "bpg_f", frameIdx: 0, filter: "noir" }),
      root,
    );
    await saveBoothPhoto(
      db,
      jpeg("f1"),
      meta({ mode: "burst", groupId: "bpg_f", frameIdx: 1, filter: "noir" }),
      root,
    );
    const listing = await listBoothPhotos(db);
    expect(listing.groups[0].filter).toBe("noir");
    expect(listing.groups[0].frames.map((f) => f.filter)).toEqual(["noir", "noir"]);
  });

  it("clears the filter across a whole group and reports the count", async () => {
    await saveBoothPhoto(
      db,
      jpeg("f0"),
      meta({ mode: "burst", groupId: "bpg_c", frameIdx: 0, filter: "noir" }),
      root,
    );
    await saveBoothPhoto(
      db,
      jpeg("f1"),
      meta({ mode: "burst", groupId: "bpg_c", frameIdx: 1, filter: "noir" }),
      root,
    );

    const { cleared } = await clearBoothGroupFilter(db, "bpg_c");
    expect(cleared).toBe(2);
    expect(db.rows.every((r: BoothRow) => r.filter === null)).toBe(true);
    const listing = await listBoothPhotos(db);
    expect(listing.groups[0].filter).toBeNull();
    expect(listing.groups[0].frames.every((f) => f.filter === null)).toBe(true);
  });

  it("accepts a raw JPEG under gif mode only when it is a source-only frame", async () => {
    // The assembled .gif, plus its raw JPEG source frames, in one group.
    await saveBoothPhoto(db, gif("anim"), meta({ mode: "gif", groupId: "bpg_g" }), root);
    await saveBoothPhoto(
      db,
      jpeg("srcframe"),
      meta({ mode: "gif", groupId: "bpg_g", frameIdx: 1, sourceOnly: true, filter: "noir" }),
      root,
    );
    const src = db.rows.find((r: BoothRow) => r.sourceOnly);
    expect(src?.mimeType).toBe("image/jpeg");
    expect(src?.path.endsWith(".jpg")).toBe(true);

    // The same JPEG under gif mode WITHOUT source-only is a format mismatch.
    await expect(
      saveBoothPhoto(db, jpeg("x"), meta({ mode: "gif", groupId: "bpg_g" }), root),
    ).rejects.toThrow(/GIF/);
  });

  it("hides source-only frames from the listing, leaving the gif as the sole item", async () => {
    await saveBoothPhoto(db, gif("anim"), meta({ mode: "gif", groupId: "bpg_g" }), root);
    await saveBoothPhoto(
      db,
      jpeg("f0"),
      meta({ mode: "gif", groupId: "bpg_g", frameIdx: 1, sourceOnly: true }),
      root,
    );
    await saveBoothPhoto(
      db,
      jpeg("f1"),
      meta({ mode: "gif", groupId: "bpg_g", frameIdx: 2, sourceOnly: true }),
      root,
    );

    const listing = await listBoothPhotos(db);
    expect(listing.totalCount).toBe(1);
    expect(listing.groups).toHaveLength(1);
    expect(listing.groups[0].frames).toHaveLength(1);
    expect(listing.groups[0].frames[0].mimeType).toBe("image/gif");
  });

  it("soft-deleting a gif group stamps its source-only frames too", async () => {
    await saveBoothPhoto(db, gif("anim"), meta({ mode: "gif", groupId: "bpg_g" }), root);
    await saveBoothPhoto(
      db,
      jpeg("f0"),
      meta({ mode: "gif", groupId: "bpg_g", frameIdx: 1, sourceOnly: true }),
      root,
    );

    const { removed } = await softDeleteBoothGroup(db, "bpg_g");
    expect(removed).toBe(2);
    expect(db.rows.every((r: BoothRow) => r.softDeletedAt != null)).toBe(true);
  });

  it("clearFilter nulls the filter on source-only frames of the group", async () => {
    await saveBoothPhoto(db, gif("anim"), meta({ mode: "gif", groupId: "bpg_g" }), root);
    await saveBoothPhoto(
      db,
      jpeg("f0"),
      meta({ mode: "gif", groupId: "bpg_g", frameIdx: 1, sourceOnly: true, filter: "noir" }),
      root,
    );

    const { cleared } = await clearBoothGroupFilter(db, "bpg_g");
    expect(cleared).toBe(2);
    expect(db.rows.every((r: BoothRow) => r.filter === null)).toBe(true);
  });

  it("read rejects path traversal", async () => {
    expect(await readBoothPhoto("../../etc/passwd", root)).toBeNull();
    expect(await readBoothPhoto("/etc/passwd", root)).toBeNull();
  });

  it("read returns null for missing files", async () => {
    expect(await readBoothPhoto("2026-01-01T00-00-00.000Z-0.jpg", root)).toBeNull();
  });
});
