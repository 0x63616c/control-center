import { expect, it } from "vitest";
import { CodegenError, validate } from "../../../scripts/apps-gen/validate";

const baseTile = { label: "x", component: () => null, worldCol: 0, worldRow: 0, cols: 1, rows: 1 };
const base = {
  source: "feature" as const,
};
// Derives the single tile's id from the app id, so single-tile-per-app test
// cases keep distinct tile ids (only the dedicated dup-tile-id case sets a
// colliding id deliberately).
const app = (
  over: Partial<{
    id: string;
    tileId: string;
    home: boolean;
    guestExposed: boolean;
    worldCol: number;
    worldRow: number;
    cols: number;
    rows: number;
    sensitive: boolean;
    private: boolean;
  }>,
) => ({
  ...base,
  id: over.id ?? "a",
  featureDir: over.id ?? "a",
  guestExposed: over.guestExposed ?? false,
  sensitive: over.sensitive ?? false,
  private: over.private ?? false,
  tiles: [
    {
      ...baseTile,
      id: over.tileId ?? over.id ?? "a",
      home: over.home ?? false,
      worldCol: over.worldCol ?? 0,
      worldRow: over.worldRow ?? 0,
      cols: over.cols ?? 1,
      rows: over.rows ?? 1,
    },
  ],
});

const model = (apps: Array<ReturnType<typeof app>>, extra: Record<string, unknown> = {}) => ({
  apps,
  tileViews: apps.flatMap((owner) =>
    owner.tiles.map((tile) => ({
      tileId: tile.id,
      source: `feature:${owner.featureDir}`,
    })),
  ),
  ...extra,
});

it("throws on duplicate id", () => {
  expect(() => validate(model([app({ id: "a", home: true }), app({ id: "a" })]), [])).toThrow(
    CodegenError,
  );
});
it("throws when home count != 1", () => {
  expect(() => validate(model([app({ id: "a" }), app({ id: "b" })]), [])).toThrow(
    /exactly one home/,
  );
});
it("throws on overlapping tile rects", () => {
  expect(() =>
    validate(
      model([app({ id: "a", home: true, worldCol: 0, cols: 2 }), app({ id: "b", worldCol: 1 })]),
      [],
    ),
  ).toThrow(/overlap/);
});
it("throws when guestExposed flag diverges from the GUEST_EXPOSED allowlist", () => {
  expect(() => validate(model([app({ id: "a", home: true, guestExposed: true })]), [])).toThrow(
    /GUEST_EXPOSED/,
  );
  expect(() => validate(model([app({ id: "a", home: true, guestExposed: false })]), ["a"])).toThrow(
    /GUEST_EXPOSED/,
  );
});
it("accepts a consistent model", () => {
  expect(() =>
    validate(model([app({ id: "a", home: true, guestExposed: true })]), ["a"]),
  ).not.toThrow();
});

it("rejects an App that combines session and fresh unlock policies", () => {
  expect(() =>
    validate(model([app({ id: "a", home: true, sensitive: true, private: true })]), []),
  ).toThrow(/cannot be both sensitive and private/);
});

it("throws on a duplicate table name across the feature + base schemas", () => {
  expect(() =>
    validate(
      model([app({ id: "a", home: true })], {
        tables: [
          { name: "portal_authorization", source: "feature:guest-wifi" },
          { name: "portal_authorization", source: "base" },
        ],
      }),
      [],
    ),
  ).toThrow(/duplicate table name/);
});

it("throws when two features expose the same top-level router key", () => {
  expect(() =>
    validate(
      model([app({ id: "a", home: true })], {
        routerKeys: [
          { key: "portal", source: "feature:guest-wifi" },
          { key: "portal", source: "feature:other" },
        ],
      }),
      [],
    ),
  ).toThrow(/duplicate router key/);
});

it("throws when two Apps declare the same worker cycle name", () => {
  expect(() =>
    validate(
      model([app({ id: "a", home: true })], {
        workerCycles: [
          { name: "weather-ingest", source: "feature:weather" },
          { name: "weather-ingest", source: "feature:other-weather" },
        ],
      }),
      [],
    ),
  ).toThrow(/duplicate worker cycle name 'weather-ingest'/);
});

it("accepts distinct table names + router keys", () => {
  expect(() =>
    validate(
      model([app({ id: "a", home: true, guestExposed: true })], {
        tables: [
          { name: "portal_authorization", source: "feature:guest-wifi" },
          { name: "job", source: "base" },
        ],
        routerKeys: [{ key: "portal", source: "feature:guest-wifi" }],
      }),
      ["a"],
    ),
  ).not.toThrow();
});

it("throws when two schema.ts files export the same symbol name", () => {
  expect(() =>
    validate(
      model([app({ id: "a", home: true })], {
        schemaExports: [
          { name: "job", source: "feature:weight" },
          { name: "job", source: "base" },
        ],
      }),
      [],
    ),
  ).toThrow(/duplicate schema export/);
});

it("accepts today's real schema export set (feature schemas + @www/core re-exports) with no collision", () => {
  expect(() =>
    validate(
      model([app({ id: "a", home: true, guestExposed: true })], {
        schemaExports: [
          // @www/core re-exports off apps/api/src/db/schema.ts.
          { name: "deviceState", source: "base" },
          { name: "integrationSyncStatus", source: "base" },
          { name: "job", source: "base" },
          { name: "DeviceKind", source: "base" },
          { name: "LightColor", source: "base" },
          { name: "DeviceClimateState", source: "base" },
          { name: "DeviceLightState", source: "base" },
          { name: "DeviceSpeakerState", source: "base" },
          { name: "DeviceStateValue", source: "base" },
          // Distinct feature-local exports, no overlap with the base set above.
          { name: "boothPhoto", source: "feature:booth" },
          { name: "weightMeasurement", source: "feature:weight" },
        ],
      }),
      ["a"],
    ),
  ).not.toThrow();
});

// ─── multi-tile proof (F0) ────────────────────────────────────────────────

it("accepts a single app with two non-overlapping tiles, exactly one home", () => {
  const twoTile = {
    ...base,
    id: "multi",
    featureDir: "multi",
    guestExposed: false,
    tiles: [
      { ...baseTile, id: "multi_a", home: true, worldCol: 0, worldRow: 0, cols: 1, rows: 1 },
      { ...baseTile, id: "multi_b", home: false, worldCol: 2, worldRow: 0, cols: 1, rows: 1 },
    ],
  };
  expect(() => validate(model([twoTile]), [])).not.toThrow();
});

it("throws when a two-tile app has a second home tile", () => {
  const twoHome = {
    ...base,
    id: "multi",
    featureDir: "multi",
    guestExposed: false,
    tiles: [
      { ...baseTile, id: "multi_a", home: true, worldCol: 0, worldRow: 0, cols: 1, rows: 1 },
      { ...baseTile, id: "multi_b", home: true, worldCol: 2, worldRow: 0, cols: 1, rows: 1 },
    ],
  };
  expect(() => validate(model([twoHome]), [])).toThrow(/exactly one home/);
});

it("throws when two tiles of the same app overlap (intra-app overlap)", () => {
  const overlapping = {
    ...base,
    id: "multi",
    featureDir: "multi",
    guestExposed: false,
    tiles: [
      { ...baseTile, id: "multi_a", home: true, worldCol: 0, worldRow: 0, cols: 2, rows: 1 },
      { ...baseTile, id: "multi_b", home: false, worldCol: 1, worldRow: 0, cols: 2, rows: 1 },
    ],
  };
  expect(() => validate(model([overlapping]), [])).toThrow(/overlap/);
});

it("throws when two tiles (any apps) share a tile id", () => {
  expect(() =>
    validate(
      model([
        app({ id: "a", tileId: "dup", home: true }),
        app({ id: "b", tileId: "dup", worldCol: 5 }),
      ]),
      [],
    ),
  ).toThrow(/duplicate tile id/);
});

it("throws when a board Tile has no App-owned Tile View declaration", () => {
  expect(() =>
    validate(
      {
        apps: [app({ id: "tile_a", home: true })],
        tileViews: [],
      },
      [],
    ),
  ).toThrow(/missing Tile View.*tile_a/);
});

it("throws when two Apps declare a Tile View for the same Tile", () => {
  expect(() =>
    validate(
      {
        apps: [app({ id: "tile_a", home: true })],
        tileViews: [
          { tileId: "tile_a", source: "feature:a" },
          { tileId: "tile_a", source: "feature:b" },
        ],
      },
      [],
    ),
  ).toThrow(/duplicate Tile View.*tile_a/);
});

it("throws when one App claims another App's Tile View", () => {
  expect(() =>
    validate(
      {
        apps: [app({ id: "tile_a", home: true }), app({ id: "tile_b", worldCol: 2 })],
        tileViews: [
          { tileId: "tile_a", source: "feature:tile_b" },
          { tileId: "tile_b", source: "feature:tile_a" },
        ],
      },
      [],
    ),
  ).toThrow(/belongs to feature:tile_a, not feature:tile_b/);
});
