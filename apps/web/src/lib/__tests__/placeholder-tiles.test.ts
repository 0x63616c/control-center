// Guardrail for the decorative bento fill: the placeholders must completely tile
// the frame around the real cluster , no gaps, no overlaps, no slivers, nothing
// over the cluster, all in-bounds. This is the "validate without breaking it"
// check; regenerate coords in placeholder-tiles.ts and this fails loudly on any
// gap or collision.
import { describe, expect, it, vi } from "vitest";

// clusterWorldCells reads the generated TILE_REGISTRY, which imports TeslaTile →
// MapLibre. MapLibre calls window.URL.createObjectURL at import time, which jsdom
// lacks , so stub it the same way registry-guards.test.ts does.
vi.mock("pmtiles", () => ({ Protocol: vi.fn().mockImplementation(() => ({ tile: vi.fn() })) }));
vi.mock("@protomaps/basemaps", () => ({
  layers: vi.fn().mockReturnValue([]),
  namedFlavor: vi.fn().mockReturnValue({}),
}));

import {
  BENTO_TILES,
  bentoRegion,
  clusterWorldCells,
  placeholderViolations,
} from "../placeholder-tiles";

describe("placeholder bento layout", () => {
  it("fully tiles the frame with no gaps, overlaps, slivers, or cluster collisions", () => {
    expect(placeholderViolations()).toEqual([]);
  });

  it("surrounds the cluster on every side (organic, not one-sided)", () => {
    const cluster = clusterWorldCells();
    const minCol = Math.min(...cluster.map((c) => c.col));
    const maxCol = Math.max(...cluster.map((c) => c.col + c.cols));
    const minRow = Math.min(...cluster.map((c) => c.row));
    const maxRow = Math.max(...cluster.map((c) => c.row + c.rows));

    const left = BENTO_TILES.some((p) => p.col + p.cols <= minCol);
    const right = BENTO_TILES.some((p) => p.col >= maxCol);
    const above = BENTO_TILES.some((p) => p.row + p.rows <= minRow);
    const below = BENTO_TILES.some((p) => p.row >= maxRow);
    expect({ left, right, above, below }).toEqual({
      left: true,
      right: true,
      above: true,
      below: true,
    });
  });

  it("uses a variety of sizes (not all identical)", () => {
    const sizes = new Set(BENTO_TILES.map((p) => `${p.cols}x${p.rows}`));
    expect(sizes.size).toBeGreaterThanOrEqual(5);
  });

  it("exposes a bento region wider than the cluster on all sides", () => {
    const region = bentoRegion();
    const cluster = clusterWorldCells();
    expect(region.c0).toBeLessThan(Math.min(...cluster.map((c) => c.col)));
    expect(region.r0).toBeLessThan(Math.min(...cluster.map((c) => c.row)));
    expect(region.c1).toBeGreaterThan(Math.max(...cluster.map((c) => c.col + c.cols - 1)));
    expect(region.r1).toBeGreaterThan(Math.max(...cluster.map((c) => c.row + c.rows - 1)));
  });
});
