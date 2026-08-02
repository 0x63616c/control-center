import { expect, it } from "vitest";
import { defineTileViews } from "../../../app-kit";
import { collect, collectTileViewsExport } from "../../../scripts/apps-gen/collect";
import { validate } from "../../../scripts/apps-gen/validate";

it("requires the conventional tileViews export consumed by web.gen.ts", () => {
  const tileViews = defineTileViews([{ tileId: "tile_weather" }]);

  expect(collectTileViewsExport({ tileViews }, "weather")).toBe(tileViews);
  expect(() => collectTileViewsExport({ views: tileViews }, "weather")).toThrow(
    /exactly one.*named tileViews/,
  );
  expect(() => collectTileViewsExport({ tileViews, views: tileViews }, "weather")).toThrow(
    /exactly one.*named tileViews/,
  );
});

// Sanity check that collection over the real App facets produces one complete,
// valid model.
it("collect() includes the guest-wifi App manifest exactly once", async () => {
  const model = await collect();

  // The guest-wifi tile is sourced from features/guest-wifi/manifest.ts (source
  // "feature"), and appears exactly once.
  const guest = model.apps.filter((a) => a.id === "tile_guestwifi");
  expect(guest).toHaveLength(1);
  expect(guest[0].source).toBe("feature");
  expect(guest[0].guestExposed).toBe(true);

  // The fold surfaces: the feature's tables, its router key, and its Temporal
  // schedule (ADR-0008 — the old defineCron seam is gone).
  expect(model.features.map((f) => f.dir)).toContain("guest-wifi");
  expect(model.tables.map((t) => t.name)).toEqual(
    expect.arrayContaining(["portal_authorization", "portal_rate_limit"]),
  );
  expect(model.routerKeys).toContainEqual({ key: "portal", source: "feature:guest-wifi" });
  expect(model.temporalSchedules.map((s) => s.scheduleId)).toContain("app_guest-wifi_purge");

  // The feature's schema.ts named exports are collected with a feature source
  // label (used to detect schema.gen.ts `export *` symbol collisions).
  expect(model.schemaExports).toContainEqual({
    name: "portalAuthorization",
    source: "feature:guest-wifi",
  });
  expect(model.schemaExports).toContainEqual({
    name: "portalRateLimit",
    source: "feature:guest-wifi",
  });

  // And the whole collected model still validates against the real allowlist.
  expect(() => validate(model, ["tile_guestwifi"])).not.toThrow();
});

// The base apps/api/src/db/schema.ts module re-exports several symbols from
// @www/core (`export { ... } from "@www/core"`, not a local declaration).
// Object.keys() on the imported module module picks these up the same way as
// locally-declared exports, so they must appear with source "base".
it("collect() sources the base schema's @www/core re-exports with source 'base'", async () => {
  const model = await collect();
  const baseExportNames = model.schemaExports.filter((e) => e.source === "base").map((e) => e.name);
  expect(baseExportNames).toEqual(
    expect.arrayContaining(["deviceState", "integrationSyncStatus", "job", "DeviceKind"]),
  );
});

// Track C, final tile fold: the booth-photo upload facet moved out of the
// interim http list into features/booth/http.ts, collected via Source A (the
// same path api.ts/jobs.ts use), not the interim list — the last entry to
// leave INTERIM_HTTP_MODULES, which is now permanently empty.
it("sources the booth-photo route from the booth feature, not the interim list", async () => {
  const model = await collect();

  expect(model.httpRoutes).toContainEqual({
    method: "POST",
    path: "/media/booth-photo",
    match: "exact",
    source: "feature:booth",
  });
  expect(model.httpModules.map((m) => m.ident)).toContain("boothHttp");
});

// Track C, Wave 5 fold: the wake-photo upload facet moved out of the interim
// http list into features/wakes/http.ts, collected via Source A (the same path
// api.ts/jobs.ts use), not the interim list.
it("collect() sources the wake-photo route from the wakes feature, not the interim list", async () => {
  const model = await collect();

  expect(model.httpRoutes).toContainEqual({
    method: "POST",
    path: "/media/wake-photo",
    match: "exact",
    source: "feature:wakes",
  });
  expect(model.httpModules.map((m) => m.ident)).toContain("wakesHttp");
});

// The first multi-tile fold: features/weather declares TWO tiles
// (tile_weath + tile_hourly) under one app id (tile_weather). This is the
// regression guard for the collect.ts dedup fix — a multi-tile app's tile ids
// differ from its app id, so the registry-leftover filter must dedup on the
// union of feature TILE ids, not app ids, or both tiles double-collect.
it("collect() sources both weather tiles once from the two-tile feature manifest", async () => {
  const model = await collect();
  const weather = model.apps.filter((a) => a.id === "tile_weather");
  expect(weather).toHaveLength(1);
  expect(weather[0].source).toBe("feature");
  expect(weather[0].tiles.map((t) => t.id).sort()).toEqual(["tile_hourly", "tile_weath"]);
  // The BLOCKER regression guard: neither tile id leaks back in as a registry app.
  expect(model.apps.filter((a) => a.id === "tile_weath")).toHaveLength(0);
  expect(model.apps.filter((a) => a.id === "tile_hourly")).toHaveLength(0);
  expect(() => validate(model, ["tile_guestwifi"])).not.toThrow();
});

// Second multi-tile fold: features/events declares TWO tiles (tile_event +
// tile_clock) under one app id (tile_events). Same collect.ts dedup guard as
// weather above, plus this is the first fold that moves the board HOME tile —
// tile_clock's home:true must survive the collect into a single global home.
it("collect() sources both events tiles once from the two-tile feature manifest", async () => {
  const model = await collect();
  const events = model.apps.filter((a) => a.id === "tile_events");
  expect(events).toHaveLength(1);
  expect(events[0].source).toBe("feature");
  expect(events[0].tiles.map((t) => t.id).sort()).toEqual(["tile_clock", "tile_event"]);
  // Neither tile id leaks back in as a registry app.
  expect(model.apps.filter((a) => a.id === "tile_clock")).toHaveLength(0);
  expect(model.apps.filter((a) => a.id === "tile_event")).toHaveLength(0);
  expect(() => validate(model, ["tile_guestwifi"])).not.toThrow();
});

it("collect() finds one App-owned Tile View declaration for every board Tile", async () => {
  const model = await collect();
  const tileIds = model.apps.flatMap((app) => app.tiles.map((tile) => tile.id)).sort();

  expect(model.tileViews.map((view) => view.tileId).sort()).toEqual(tileIds);
  expect(model.tileViews).toContainEqual({
    tileId: "tile_weath",
    source: "feature:weather",
  });
});
