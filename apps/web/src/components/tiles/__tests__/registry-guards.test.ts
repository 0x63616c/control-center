/**
 * CI guards for the tile registry.
 * (1) Registry covers every cell of the GRID_COLS×GRID_ROWS grid with no overlaps or gaps.
 * (2) Every registry entry's view component has a matching *.stories.tsx file.
 * (3) tilePixelSize derives the true production footprint for each tile.
 */
import { describe, expect, it, vi } from "vitest";

// MapLibre (via TeslaTile, imported transitively by web.gen.ts) calls
// window.URL.createObjectURL at import time , unavailable in jsdom.
vi.mock("pmtiles", () => ({ Protocol: vi.fn().mockImplementation(() => ({ tile: vi.fn() })) }));
vi.mock("@protomaps/basemaps", () => ({
  layers: vi.fn().mockReturnValue([]),
  namedFlavor: vi.fn().mockReturnValue({}),
}));

import { TILE_REGISTRY } from "@features/_generated/web.gen";
import { tilePixelSize, WORLD_COLS, WORLD_ROWS } from "../../../lib/grid-constants";

describe("tile registry , free placement", () => {
  it("all tiles are defined with Stripe-style IDs", () => {
    for (const entry of TILE_REGISTRY) {
      expect(entry.id).toMatch(/^tile_[a-z]+$/);
    }
  });

  it("every tile sits fully inside the world (free-placed, no off-world spill)", () => {
    for (const { id, worldCol, worldRow, cols, rows } of TILE_REGISTRY) {
      expect(worldCol, `${id} worldCol`).toBeGreaterThanOrEqual(0);
      expect(worldRow, `${id} worldRow`).toBeGreaterThanOrEqual(0);
      expect(worldCol + cols, `${id} col end`).toBeLessThanOrEqual(WORLD_COLS);
      expect(worldRow + rows, `${id} row end`).toBeLessThanOrEqual(WORLD_ROWS);
    }
  });

  it("real tiles never overlap each other", () => {
    const overlaps = (a: (typeof TILE_REGISTRY)[number], b: (typeof TILE_REGISTRY)[number]) =>
      a.worldCol < b.worldCol + b.cols &&
      a.worldCol + a.cols > b.worldCol &&
      a.worldRow < b.worldRow + b.rows &&
      a.worldRow + a.rows > b.worldRow;
    for (let i = 0; i < TILE_REGISTRY.length; i++) {
      for (let j = i + 1; j < TILE_REGISTRY.length; j++) {
        expect(
          overlaps(TILE_REGISTRY[i], TILE_REGISTRY[j]),
          `${TILE_REGISTRY[i].id} overlaps ${TILE_REGISTRY[j].id}`,
        ).toBe(false);
      }
    }
  });

  it("exactly one tile is flagged home (the board's open/idle target)", () => {
    expect(TILE_REGISTRY.filter((t) => t.home)).toHaveLength(1);
  });
});

describe("tile registry , story coverage", () => {
  // Enumerate every tile story file at build time (Vite glob). Scan ALL of
  // components/ , registered tile views are co-located with their domain, not
  // always under components/tiles/, so a tiles-only glob would wrongly report
  // their stories as missing (www-w6ug).
  // Folded features with a full web/ component subtree (weather is the first,
  // Track C Wave 7) keep their stories under features/<dir>/web/, so that tree
  // is scanned too. Single-tile folds (felogs is the first, Track C Wave 7)
  // inline the view into a root-level web.tsx and keep the story alongside it
  // as web.stories.tsx, so the feature root is scanned as well.
  const storyFiles = [
    ...Object.keys(import.meta.glob("../../**/*.stories.tsx")),
    ...Object.keys(import.meta.glob("../../../../../../features/*/web/**/*.stories.tsx")),
    ...Object.keys(import.meta.glob("../../../../../../features/*/*.stories.tsx")),
  ];

  it("every registry view component has a matching *.stories.tsx file", () => {
    for (const { id, viewComponent } of TILE_REGISTRY) {
      const expectedFile = `${viewComponent.name}.stories.tsx`;
      const found = storyFiles.some((p) => p.endsWith(`/${expectedFile}`));
      expect(
        found,
        `${id}: missing ${expectedFile} , every registry tile needs a stories file`,
      ).toBe(true);
    }
  });
});

describe("tile registry , pixel footprint", () => {
  it("derives the clock tile (5×3) at its known production size ~544×319", () => {
    const { width, height } = tilePixelSize(5, 3);
    expect(width).toBeCloseTo(543.67, 1);
    expect(height).toBeCloseTo(319.0, 1);
  });

  it("gives each registry tile a non-zero footprint that grows with span", () => {
    for (const { id, cols, rows } of TILE_REGISTRY) {
      const { width, height } = tilePixelSize(cols, rows);
      expect(width, `${id} width`).toBeGreaterThan(0);
      expect(height, `${id} height`).toBeGreaterThan(0);
    }
    // A wider/taller span must produce a larger box than a smaller one.
    expect(tilePixelSize(4, 3).width).toBeGreaterThan(tilePixelSize(3, 3).width);
    expect(tilePixelSize(4, 3).height).toBeGreaterThan(tilePixelSize(4, 2).height);
  });
});
