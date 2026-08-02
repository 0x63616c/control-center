// Decorative placeholder tiles , empty tile backgrounds that bento-tile the ENTIRE
// pannable world around the real tiles, so panning the canvas in any direction
// reveals a fully populated dashboard (flush tiles, varied sizes, no dotted voids,
// no empty frontier) rather than empty grid. They carry no content, are
// non-interactive, and never appear in the real registry.
//
// The fill is two layers, produced by `bentoFor(tiles)`:
//   1. the inner fill , varied bento tiling the inner region (the world minus the
//      wall ring) AROUND whichever real tiles are passed in. Produced by the
//      bento-fill generator (fillAround), which carves the fill around the real
//      tiles' world rects as reserved holes. Because the real tiles are
//      free-placed (any number, anywhere, any size , and now server-resolved, see
//      board-layout.ts), this regenerates to fit them with no hand-authored
//      coordinate tables , move a tile and the bento reflows around it.
//   2. the WALL ring , a WALL_THICKNESS-cell-thick organic border of varied
//      2..4-long tiles around the entire world edge, generated once by
//      buildWall() (fixed geometry, independent of tile placement) and reused by
//      every bentoFor call. It reads as a thick frame enclosing the dashboard;
//      same styling as the bento (no new tile type), and the varied sizes absorb
//      the edge length with no special corner tile.
// Together they cover every world cell exactly once (minus the real tiles),
// asserted gap-free / overlap-free / sliver-free by placeholder-tiles.test.ts.
// BENTO_TILES below is `bentoFor(clusterWorldCells())` , the static
// registry defaults , kept as module-load consts for the test and as the
// initial/fallback fill before the server layout resolves.

import { TILE_REGISTRY } from "@features/_generated/web.gen";
import { fillAround, type Rect } from "./bento-fill";
import { WALL_THICKNESS, WORLD_COLS, WORLD_ROWS } from "./grid-constants";

export type PlaceholderTile = {
  id: string;
  col: number;
  row: number;
  cols: number;
  rows: number;
};

// Seeds for the deterministic best-of-N bento fill. Fixed so the layout is byte
// identical every load (no flicker) yet looks organic. Bump BENTO_ATTEMPTS for a
// cleaner seam structure at a small module-load cost.
// 120 was too few once the media tiles grew the layout to 13 holes: no seed in
// the first 120 yielded a gap-free tiling, so fillAround threw at module init and
// red-lit CI (www-apwz). The first gap-free seed lands around i≈120–300; 500 gives
// comfortable margin over fillAround's own 300 default without much load cost.
const BENTO_SEED = 1234;
const BENTO_ATTEMPTS = 500;

// The inner region the bento must fill: the world minus the wall ring on each side.
const INNER_COLS = WORLD_COLS - 2 * WALL_THICKNESS;
const INNER_ROWS = WORLD_ROWS - 2 * WALL_THICKNESS;

// Inner bento fill in world coords: generate around whichever tiles are passed
// in, then shift each tile out past the wall ring. ids are stable by index for
// React keys. `tiles` are world-cell rects (real tiles, from either the static
// registry or the server-resolved layout) that the fill must avoid.
function innerFillFor(
  tiles: { col: number; row: number; cols: number; rows: number }[],
): PlaceholderTile[] {
  const holes: Rect[] = tiles.map((t) => ({
    col: t.col - WALL_THICKNESS,
    row: t.row - WALL_THICKNESS,
    cols: t.cols,
    rows: t.rows,
  }));
  return fillAround(INNER_COLS, INNER_ROWS, holes, {
    seed: BENTO_SEED,
    attempts: BENTO_ATTEMPTS,
  }).map((t, i) => ({
    id: `tile_ph_${String(i + 1).padStart(3, "0")}`,
    col: t.col + WALL_THICKNESS,
    row: t.row + WALL_THICKNESS,
    cols: t.cols,
    rows: t.rows,
  }));
}

// Full decorative fill (inner bento + wall ring) around an arbitrary set of real
// tiles. The wall ring is fixed geometry (independent of tile placement), so it's
// built once and reused; only the inner fill regenerates per-call. Used both at
// module load (the static registry defaults) and per-render by the board once
// tiles are free-placed by the server-resolved layout (Task 6).
export function bentoFor(
  tiles: { col: number; row: number; cols: number; rows: number }[],
): PlaceholderTile[] {
  return [...innerFillFor(tiles), ...WALL_RING];
}

// Partition `length` into varied parts of 2..4, deterministically (seeded LCG, so
// the ring is identical every run yet looks organic, not periodic). The tail is
// kept ≥2 so a part is never a 1-cell sliver , this also absorbs odd lengths
// naturally, with no special corner tile.
function partition(length: number, seed: number): number[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const parts: number[] = [];
  let remaining = length;
  while (remaining > 4) {
    let len = 2 + Math.floor(rand() * 3); // 2..4
    if (remaining - len < 2) len = 2; // never leave a 1-cell tail
    parts.push(len);
    remaining -= len;
  }
  parts.push(remaining); // 2, 3, or 4
  return parts;
}

// Build the wall ring: a WALL_THICKNESS-thick organic border around the whole
// world. Each of the four bands is a strip of varied 2..4-long tiles (see
// partition), so there's no uniform grid to break and nothing odd stands out at
// the corners. Together with INNER_FILL this covers every world cell exactly once.
function buildWall(): PlaceholderTile[] {
  const w = WALL_THICKNESS;
  const lastLo = w; // first inner column/row
  const lastHi = WORLD_COLS - w; // first column/row of the far wall band
  const tiles: PlaceholderTile[] = [];
  let n = 0;
  const id = () => `tile_wall_${String(++n).padStart(3, "0")}`;

  // Lay a varied strip of tiles spanning `length` cells along one axis. `axis`
  // picks which dimension the strip walks; the other dimension is the wall depth.
  const band = (
    start: number,
    length: number,
    fixed: number,
    axis: "h" | "v",
    seed: number,
  ): void => {
    let pos = start;
    for (const span of partition(length, seed)) {
      tiles.push(
        axis === "h"
          ? { id: id(), col: pos, row: fixed, cols: span, rows: w }
          : { id: id(), col: fixed, row: pos, cols: w, rows: span },
      );
      pos += span;
    }
  };

  // Top & bottom bands span the full width; left & right bands fill only the gap
  // between them, so corners belong to top/bottom and nothing overlaps. Distinct
  // seeds per band keep the four sides from sharing the same rhythm.
  band(0, WORLD_COLS, 0, "h", 0x70b); // top
  band(0, WORLD_COLS, lastHi, "h", 0xb07); // bottom
  band(lastLo, lastHi - lastLo, 0, "v", 0x1ef7); // left
  band(lastLo, lastHi - lastLo, lastHi, "v", 0x21c4); // right
  return tiles;
}

// The wall ring is fixed geometry (independent of tile placement), built once at
// module load and reused by every bentoFor call.
const WALL_RING: PlaceholderTile[] = buildWall();

// Full decorative fill for the static registry defaults, kept as the module-load
// const for the validation test and as the initial/fallback layout fill.
export const BENTO_TILES: PlaceholderTile[] = bentoFor(clusterWorldCells());

// ── validation (used by the test, kept beside the data it validates) ──

type Cell = { col: number; row: number; cols: number; rows: number };

function overlaps(a: Cell, b: Cell): boolean {
  return (
    a.col < b.col + b.cols &&
    a.col + a.cols > b.col &&
    a.row < b.row + b.rows &&
    a.row + a.rows > b.row
  );
}

// World-cell footprints of the real tiles, straight from the registry's world
// coords , so the validator tracks tile placement automatically. (Named *cluster*
// for continuity with the test; there is no cluster concept anymore, just the set
// of free-placed real tiles the bento must avoid.)
export function clusterWorldCells(): Cell[] {
  return TILE_REGISTRY.map((t) => ({
    col: t.worldCol,
    row: t.worldRow,
    cols: t.cols,
    rows: t.rows,
  }));
}

// The region the bento must fill: the entire world.
export function bentoRegion(): { c0: number; c1: number; r0: number; r1: number } {
  return { c0: 0, c1: WORLD_COLS - 1, r0: 0, r1: WORLD_ROWS - 1 };
}

function inCluster(col: number, row: number, cluster: Cell[]): boolean {
  return cluster.some(
    (c) => col >= c.col && col < c.col + c.cols && row >= c.row && row < c.row + c.rows,
  );
}

// Every layout invariant in one place: in-bounds, no self-overlap, no real-tile
// overlap, no slivers (<2 cells per side), and FULL coverage of the world (every
// non-tile cell covered exactly once). Empty == valid.
export function placeholderViolations(): string[] {
  const errs: string[] = [];
  const cluster = clusterWorldCells();
  const region = bentoRegion();

  for (const p of BENTO_TILES) {
    if (p.cols < 2 || p.rows < 2) errs.push(`${p.id} is a sliver (${p.cols}x${p.rows})`);
    if (
      p.col < region.c0 ||
      p.row < region.r0 ||
      p.col + p.cols - 1 > region.c1 ||
      p.row + p.rows - 1 > region.r1
    ) {
      errs.push(`${p.id} outside world`);
    }
    for (const c of cluster) {
      if (overlaps(p, c)) errs.push(`${p.id} overlaps real tile`);
    }
  }
  for (let i = 0; i < BENTO_TILES.length; i++) {
    for (let j = i + 1; j < BENTO_TILES.length; j++) {
      if (overlaps(BENTO_TILES[i], BENTO_TILES[j])) {
        errs.push(`${BENTO_TILES[i].id} overlaps ${BENTO_TILES[j].id}`);
      }
    }
  }
  const covered = new Set<string>();
  for (const p of BENTO_TILES) {
    for (let r = p.row; r < p.row + p.rows; r++) {
      for (let c = p.col; c < p.col + p.cols; c++) covered.add(`${c},${r}`);
    }
  }
  for (let r = region.r0; r <= region.r1; r++) {
    for (let c = region.c0; c <= region.c1; c++) {
      if (inCluster(c, r, cluster)) continue;
      if (!covered.has(`${c},${r}`)) errs.push(`gap at cell ${c},${r}`);
    }
  }
  return errs;
}
