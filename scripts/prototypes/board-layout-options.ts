// Scratch analysis for issue #68 , NOT part of the app. Builds candidate
// rearrangements of the REAL tile registry (same ids/sizes, new worldCol/
// worldRow), checks for overlaps, reports resting-view IN/CLIPPED/OUT same as
// board-resting-view.ts, and runs the REAL bento fillAround() against each to
// confirm the decorative fill still tiles gap-free (mirrors
// placeholder-tiles.test.ts's own invariant check).
import { fillAround } from "../../apps/web/src/lib/bento-fill";
import {
  BOARD_H,
  BOARD_W,
  tileWorldRect,
  WALL_THICKNESS,
  WORLD_COLS,
  WORLD_ROWS,
} from "../../apps/web/src/lib/grid-constants";
import { HOME_TILE, TILE_REGISTRY } from "../../apps/web/src/lib/tile-registry";

type Cell = { id: string; label: string; col: number; row: number; cols: number; rows: number };

const BASE: Cell[] = TILE_REGISTRY.map((t) => ({
  id: t.id,
  label: t.label,
  col: t.worldCol,
  row: t.worldRow,
  cols: t.cols,
  rows: t.rows,
}));

function withOverrides(overrides: Record<string, { col: number; row: number }>): Cell[] {
  return BASE.map((c) => (overrides[c.id] ? { ...c, ...overrides[c.id] } : c));
}

// ── Option 1: gap-only fix , move booth/guestwifi/weight off the row-22 band
// (which clips ~15px above the resting viewport) down to a new row directly
// flush against the existing bottom-packed band (row 33), so they read as a
// continuous cluster instead of floating debris with a gap above them.
const OPTION_1 = withOverrides({
  tile_guestwifi: { col: 26, row: 34 },
  tile_booth: { col: 28, row: 34 },
  tile_weight: { col: 30, row: 34 },
});

// ── Option 2: full rebalance , Option 1's fix, PLUS relocate the two
// furthest-right tiles (dogcam, notif @ col38) to a symmetric block left of
// the TV tile, so the layout isn't 6-tiles-right vs 1-tile-left of the
// resting window anymore.
const OPTION_2 = withOverrides({
  tile_guestwifi: { col: 26, row: 34 },
  tile_booth: { col: 28, row: 34 },
  tile_weight: { col: 30, row: 34 },
  tile_notif: { col: 14, row: 24 },
  tile_dogcam: { col: 14, row: 27 },
});

function overlaps(a: Cell, b: Cell): boolean {
  return (
    a.col < b.col + b.cols &&
    a.col + a.cols > b.col &&
    a.row < b.row + b.rows &&
    a.row + a.rows > b.row
  );
}

function checkOverlaps(cells: Cell[]): string[] {
  const errs: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      if (overlaps(cells[i], cells[j])) errs.push(`${cells[i].id} overlaps ${cells[j].id}`);
    }
  }
  return errs;
}

function restingReport(cells: Cell[]): {
  in: number;
  clipped: number;
  out: number;
  leftOfViewport: number;
  rightOfViewport: number;
} {
  const home = cells.find((c) => c.id === HOME_TILE.id);
  if (!home) throw new Error(`${HOME_TILE.id} missing from cells`);
  const homeRect = tileWorldRect({
    worldCol: home.col,
    worldRow: home.row,
    cols: home.cols,
    rows: home.rows,
  });
  const homeCx = homeRect.x + homeRect.w / 2;
  const homeCy = homeRect.y + homeRect.h / 2;
  const vp = {
    x0: homeCx - BOARD_W / 2,
    x1: homeCx + BOARD_W / 2,
    y0: homeCy - BOARD_H / 2,
    y1: homeCy + BOARD_H / 2,
  };

  let vIn = 0;
  let vClipped = 0;
  let vOut = 0;
  let left = 0;
  let right = 0;
  for (const c of cells) {
    const rect = tileWorldRect({ worldCol: c.col, worldRow: c.row, cols: c.cols, rows: c.rows });
    const fullyIn =
      rect.x >= vp.x0 && rect.x + rect.w <= vp.x1 && rect.y >= vp.y0 && rect.y + rect.h <= vp.y1;
    const fullyOut =
      rect.x + rect.w <= vp.x0 || rect.x >= vp.x1 || rect.y + rect.h <= vp.y0 || rect.y >= vp.y1;
    if (fullyIn) vIn++;
    else if (fullyOut) vOut++;
    else vClipped++;
    // "Overhang" past the resting viewport's left/right pixel edge , matches
    // the manual col-range analysis (viewport ~cols 22-34 for the registry).
    if (c.id !== HOME_TILE.id) {
      if (rect.x + rect.w <= vp.x0) left++;
      if (rect.x >= vp.x1) right++;
    }
  }
  return { in: vIn, clipped: vClipped, out: vOut, leftOfViewport: left, rightOfViewport: right };
}

function bentoReport(cells: Cell[]): { ok: boolean; violations: string[] } {
  const INNER_COLS = WORLD_COLS - 2 * WALL_THICKNESS;
  const INNER_ROWS = WORLD_ROWS - 2 * WALL_THICKNESS;
  const holes = cells.map((c) => ({
    col: c.col - WALL_THICKNESS,
    row: c.row - WALL_THICKNESS,
    cols: c.cols,
    rows: c.rows,
  }));
  try {
    const fill = fillAround(INNER_COLS, INNER_ROWS, holes, { seed: 1234, attempts: 500 }).map(
      (t) => ({
        col: t.col + WALL_THICKNESS,
        row: t.row + WALL_THICKNESS,
        cols: t.cols,
        rows: t.rows,
      }),
    );
    // Full coverage + no-overlap-with-real-tiles check (same invariant as
    // placeholder-tiles.ts's placeholderViolations, adapted to arbitrary tiles).
    const violations: string[] = [];
    for (const f of fill) {
      for (const c of cells) {
        if (overlaps(f, c)) violations.push(`bento tile overlaps ${c.id}`);
      }
    }
    const covered = new Set<string>();
    for (const f of fill) {
      for (let r = f.row; r < f.row + f.rows; r++)
        for (let cc = f.col; cc < f.col + f.cols; cc++) covered.add(`${cc},${r}`);
    }
    const inTile = (col: number, row: number) =>
      cells.some(
        (c) => col >= c.col && col < c.col + c.cols && row >= c.row && row < c.row + c.rows,
      );
    // Only the INNER region is fillAround's contract , the wall ring (outer
    // WALL_THICKNESS band) is separate fixed geometry in the real app
    // (placeholder-tiles.ts's buildWall()), irrelevant to whether a tile
    // rearrangement still lets the inner bento tile gap-free.
    for (let r = WALL_THICKNESS; r < WORLD_ROWS - WALL_THICKNESS; r++) {
      for (let cc = WALL_THICKNESS; cc < WORLD_COLS - WALL_THICKNESS; cc++) {
        if (inTile(cc, r)) continue;
        if (!covered.has(`${cc},${r}`)) violations.push(`gap at ${cc},${r}`);
      }
    }
    return { ok: violations.length === 0, violations: violations.slice(0, 5) };
  } catch (e) {
    return { ok: false, violations: [`fillAround threw: ${(e as Error).message}`] };
  }
}

for (const [name, cells] of [
  ["CURRENT (registry)", BASE],
  ["OPTION 1 (gap-only fix)", OPTION_1],
  ["OPTION 2 (full rebalance)", OPTION_2],
] as const) {
  const overlapErrs = checkOverlaps(cells);
  const resting = restingReport(cells);
  const bento = bentoReport(cells);
  console.log(`\n=== ${name} ===`);
  console.log("real-tile overlaps:", overlapErrs.length ? overlapErrs : "none");
  console.log("resting view:", resting);
  console.log("bento gap-free:", bento.ok ? "PASS" : `FAIL (${bento.violations.join("; ")})`);
}
