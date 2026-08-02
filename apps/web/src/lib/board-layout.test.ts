// Pure scanline resolver: tile positions come straight from the TILE_REGISTRY
// defaults, and any collision between two defaulted tiles is resolved by
// scanning row-major for the first free slot, wrapping the inner world (wall
// ring excluded). No React, no network , see board-layout.ts. (The saved
// board_tile_placement override path was removed in Q4 — position is now
// registry-only.)
import { describe, expect, it, vi } from "vitest";

// resolveLayout's default registry param reads TILE_REGISTRY, which
// transitively imports TeslaTile → MapLibre. MapLibre calls
// window.URL.createObjectURL at import time, which jsdom lacks , stub it the
// same way placeholder-tiles.test.ts / registry-guards.test.ts do.
vi.mock("pmtiles", () => ({ Protocol: vi.fn().mockImplementation(() => ({ tile: vi.fn() })) }));
vi.mock("@protomaps/basemaps", () => ({
  layers: vi.fn().mockReturnValue([]),
  namedFlavor: vi.fn().mockReturnValue({}),
}));

import { TILE_REGISTRY } from "@features/_generated/web.gen";
import { resolveLayout, type TileRegistryEntry } from "./board-layout";

// Assertion helper: registry lookups in these tests are for ids that must
// exist; failing loudly beats a non-null assertion.
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected value to be present");
  return value;
}

describe("resolveLayout", () => {
  it("positions each tile at its registry coordinates with no saved override", () => {
    // Post-Q4: resolveLayout takes no saved-overrides arg (that path is
    // deleted). The registry is authored collision-free, so every tile lands at
    // its exact registry coords with no scanline relocation.
    const layout = resolveLayout();
    for (const entry of TILE_REGISTRY) {
      const tile = layout.tiles.find((t) => t.id === entry.id);
      expect(tile).toBeDefined();
      expect(tile).toMatchObject({ worldCol: entry.worldCol, worldRow: entry.worldRow });
    }
    expect(layout.tiles.length).toBe(TILE_REGISTRY.length);
    expect(layout.unplaced).toEqual([]);
  });

  it("scanlines a defaulted tile whose registry position collides with another", () => {
    // Two 1x1 tiles authored on the SAME cell in a synthetic registry: the
    // first keeps its position, the second must scanline off it. Exercises the
    // Pass-2 collision resolver that still guards against registry-default
    // collisions.
    const registry: TileRegistryEntry[] = [
      { id: "tile_a", label: "A", worldCol: 3, worldRow: 3, cols: 1, rows: 1 } as TileRegistryEntry,
      { id: "tile_b", label: "B", worldCol: 3, worldRow: 3, cols: 1, rows: 1 } as TileRegistryEntry,
    ];
    const world = { worldCols: 8, worldRows: 8, wallThickness: 2 };
    const result = resolveLayout(registry, world);
    const a = must(result.tiles.find((t) => t.id === "tile_a"));
    const b = must(result.tiles.find((t) => t.id === "tile_b"));
    expect(a.worldCol).toBe(3);
    expect(a.worldRow).toBe(3);
    // b must have moved off the shared default and not overlap a.
    expect(b.worldCol === 3 && b.worldRow === 3).toBe(false);
    const overlaps = (
      p: { worldCol: number; worldRow: number; cols: number; rows: number },
      q: { worldCol: number; worldRow: number; cols: number; rows: number },
    ): boolean =>
      p.worldCol < q.worldCol + q.cols &&
      p.worldCol + p.cols > q.worldCol &&
      p.worldRow < q.worldRow + q.rows &&
      p.worldRow + p.rows > q.worldRow;
    expect(overlaps(a, b)).toBe(false);
    expect(result.unplaced).toEqual([]);
  });

  it("reports unplaced when the world genuinely has no slot", () => {
    // Synthetic registry seam: two 1x1 tiles sharing the ONLY valid inner cell
    // of a 1x1-inner world, forcing the second (defaulted) tile to find no slot.
    const tinyRegistry: TileRegistryEntry[] = [
      { id: "tile_a", label: "A", worldCol: 2, worldRow: 2, cols: 1, rows: 1 } as TileRegistryEntry,
      { id: "tile_b", label: "B", worldCol: 2, worldRow: 2, cols: 1, rows: 1 } as TileRegistryEntry,
    ];
    const result = resolveLayout(tinyRegistry, {
      worldCols: 5,
      worldRows: 5,
      wallThickness: 2,
    });
    expect(result.unplaced).toEqual(["tile_b"]);
    expect(result.tiles.some((t) => t.id === "tile_b")).toBe(false);
  });
});
