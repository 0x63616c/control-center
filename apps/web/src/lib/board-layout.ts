// Pure placement resolver: tile positions come straight from the TILE_REGISTRY
// defaults, resolving any collision two defaulted tiles land in via row-major
// scanline. No React, no network , the caller (Board) renders `tiles`.
//
// (The saved board_tile_placement override path — a merge of tRPC-fetched rows
// over the registry defaults — was removed in Q4. Position is now registry-only;
// this file keeps the collision resolver that guards against two registry
// defaults overlapping.)
//
// Semantics:
//   - Every tile defaults to its registry position.
//   - A tile whose default position collides with an already-resolved tile
//     scanlines row-major from that default position, wrapping through the
//     whole inner world (wall ring excluded), for the first slot the tile fits
//     into fully with no overlap.
//   - A tile that genuinely finds no slot (unreachable given the real,
//     collision-free registry; only reachable via the tiny synthetic fixtures
//     in the test) is reported in `unplaced` and dropped from `tiles`.

import { TILE_REGISTRY, type TileRegistryEntry } from "@features/_generated/web.gen";
import { WALL_THICKNESS, WORLD_COLS, WORLD_ROWS } from "./grid-constants";

export type { TileRegistryEntry };

export type ResolvedLayout = {
  tiles: (TileRegistryEntry & { worldCol: number; worldRow: number })[];
  unplaced: string[];
};

export type WorldConfig = {
  worldCols: number;
  worldRows: number;
  wallThickness: number;
};

const DEFAULT_WORLD_CONFIG: WorldConfig = {
  worldCols: WORLD_COLS,
  worldRows: WORLD_ROWS,
  wallThickness: WALL_THICKNESS,
};

type Rect = { worldCol: number; worldRow: number; cols: number; rows: number };

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.worldCol < b.worldCol + b.cols &&
    a.worldCol + a.cols > b.worldCol &&
    a.worldRow < b.worldRow + b.rows &&
    a.worldRow + a.rows > b.worldRow
  );
}

function fitsInner(rect: Rect, world: WorldConfig): boolean {
  const colStart = world.wallThickness;
  const rowStart = world.wallThickness;
  const colEnd = world.worldCols - world.wallThickness; // exclusive
  const rowEnd = world.worldRows - world.wallThickness; // exclusive
  return (
    rect.worldCol >= colStart &&
    rect.worldRow >= rowStart &&
    rect.worldCol + rect.cols <= colEnd &&
    rect.worldRow + rect.rows <= rowEnd
  );
}

// Row-major scanline for the first slot `size` fits into with no overlap
// against `placed`, starting from (defaultCol, defaultRow) and wrapping
// through the whole inner world (wall ring excluded). Returns undefined if
// genuinely no slot exists (every valid position collides).
function scanlineSlot(
  size: { cols: number; rows: number },
  defaultCol: number,
  defaultRow: number,
  placed: Rect[],
  world: WorldConfig,
): { worldCol: number; worldRow: number } | undefined {
  const colStart = world.wallThickness;
  const rowStart = world.wallThickness;
  const colEnd = world.worldCols - world.wallThickness - size.cols; // last valid col, inclusive
  const rowEnd = world.worldRows - world.wallThickness - size.rows; // last valid row, inclusive
  if (colEnd < colStart || rowEnd < rowStart) return undefined;

  // Enumerate every valid top-left in row-major order (row asc, col asc), then
  // rotate the sequence to start at the first position >= (defaultRow,
  // defaultCol) so the scan begins at (or just past) the tile's own default.
  const positions: { worldCol: number; worldRow: number }[] = [];
  for (let row = rowStart; row <= rowEnd; row++) {
    for (let col = colStart; col <= colEnd; col++) {
      positions.push({ worldCol: col, worldRow: row });
    }
  }
  if (positions.length === 0) return undefined;

  let startIndex = positions.findIndex(
    (p) => p.worldRow > defaultRow || (p.worldRow === defaultRow && p.worldCol >= defaultCol),
  );
  if (startIndex === -1) startIndex = 0;

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[(startIndex + i) % positions.length];
    const candidate: Rect = {
      worldCol: pos.worldCol,
      worldRow: pos.worldRow,
      cols: size.cols,
      rows: size.rows,
    };
    if (!fitsInner(candidate, world)) continue;
    if (placed.some((p) => overlaps(p, candidate))) continue;
    return pos;
  }
  return undefined;
}

// Place every registry tile at its default position, resolving collisions via
// scanline. `registry` and `world` default to the real board and only exist as
// a seam for tests exercising the collision + genuinely-no-slot paths.
export function resolveLayout(
  registry: TileRegistryEntry[] = TILE_REGISTRY,
  world: WorldConfig = DEFAULT_WORLD_CONFIG,
): ResolvedLayout {
  const placed: Rect[] = [];
  const tiles: (TileRegistryEntry & { worldCol: number; worldRow: number })[] = [];
  const unplaced: string[] = [];

  // Registry tiles default to their registry position, scanlining off it if
  // that position is already occupied by an earlier tile.
  for (const entry of registry) {
    const defaultRect: Rect = {
      worldCol: entry.worldCol,
      worldRow: entry.worldRow,
      cols: entry.cols,
      rows: entry.rows,
    };
    const collides = placed.some((p) => overlaps(p, defaultRect));
    if (!collides && fitsInner(defaultRect, world)) {
      const resolved = { ...entry, worldCol: entry.worldCol, worldRow: entry.worldRow };
      tiles.push(resolved);
      placed.push(resolved);
      continue;
    }

    const slot = scanlineSlot(entry, entry.worldCol, entry.worldRow, placed, world);
    if (!slot) {
      unplaced.push(entry.id);
      continue;
    }
    const resolved = { ...entry, worldCol: slot.worldCol, worldRow: slot.worldRow };
    tiles.push(resolved);
    placed.push(resolved);
  }

  return { tiles, unplaced };
}
