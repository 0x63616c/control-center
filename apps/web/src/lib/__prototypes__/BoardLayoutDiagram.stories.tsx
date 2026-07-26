/**
 * Overnight design exploration for issue #68. See BoardLayoutDiagram.tsx , the
 * three variants below are the CURRENT registry, and two rearrangements
 * proposed in the ticket comment (both verified overlap-free and bento-fill
 * gap-free by scripts/prototypes/board-layout-options.ts, which shares this
 * same data).
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
// Pulls the plain data file (features/_generated/tiles.gen.ts) rather than
// tile-registry.ts: the registry re-exports every feature's component, which
// drags in each feature's full web.tsx (tRPC clients, maplibre-gl, etc.) and
// makes this throwaway diagram's cold Vite prebundle take minutes. The
// generated file is pure data , same real cols/rows/labels, none of the
// transitive weight.
import { GENERATED_TILES } from "../../../../../features/_generated/tiles.gen";
import { BoardLayoutDiagram, type DiagramTile } from "./BoardLayoutDiagram";

const BASE: DiagramTile[] = GENERATED_TILES.map((t) => ({
  id: t.id,
  label: t.label,
  col: t.worldCol,
  row: t.worldRow,
  cols: t.cols,
  rows: t.rows,
}));

function withOverrides(overrides: Record<string, { col: number; row: number }>): DiagramTile[] {
  return BASE.map((c) => (overrides[c.id] ? { ...c, ...overrides[c.id] } : c));
}

const OPTION_1 = withOverrides({
  tile_guestwifi: { col: 26, row: 34 },
  tile_booth: { col: 28, row: 34 },
  tile_weight: { col: 30, row: 34 },
});

const OPTION_2 = withOverrides({
  tile_guestwifi: { col: 26, row: 34 },
  tile_booth: { col: 28, row: 34 },
  tile_weight: { col: 30, row: 34 },
  tile_notif: { col: 14, row: 24 },
  tile_dogcam: { col: 14, row: 27 },
});

const meta = {
  title: "Prototypes/Issue-68 board layout",
  component: BoardLayoutDiagram,
  tags: ["autodocs"],
  parameters: { boardWrapper: false },
} satisfies Meta<typeof BoardLayoutDiagram>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Current registry (features/_generated/tiles.gen.ts). Dashed outline = the resting viewport. */
export const Current: Story = {
  args: { tiles: BASE, homeId: "tile_clock" },
};

/** Option 1 , move booth/guestwifi/weight off the clipped row-22 band down to a row flush with the packed bottom band. */
export const Option1GapFix: Story = {
  name: "Option 1 , gap-only fix",
  args: { tiles: OPTION_1, homeId: "tile_clock" },
};

/** Option 2 , Option 1, plus relocate the two furthest-right tiles (dogcam, notif) to a symmetric block left of TV. */
export const Option2Rebalance: Story = {
  name: "Option 2 , full rebalance",
  args: { tiles: OPTION_2, homeId: "tile_clock" },
};
