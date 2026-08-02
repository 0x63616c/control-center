import { defineApp } from "@app-kit";
import { WeightTile, WeightTileView } from "./web";

/**
 * The weight app manifest (Track C, Wave 2). One inline `defineApp` is the
 * single source of truth for this tile: id, board placement (copied verbatim
 * from the pre-fold tile-registry entry), and components. Not guest-exposed.
 * Moved (issue #254) to worldCol 36 / worldRow 30, immediately to the right
 * of the Activity tile (tile_wakes, features/wakes/manifest.ts, worldCol
 * 34-35 / worldRow 30-31) — the two abut with no gap. This vacates the old
 * col 34 / rows-22/23 slot; re-check placeholder-tiles.test.ts if that band's
 * bento fill regresses.
 *
 * The App also owns its Withings ingest cadence through worker.ts; codegen
 * registers that cycle with the worker runtime.
 */
export default defineApp({
  id: "tile_weight",
  tiles: [
    {
      id: "tile_weight",
      label: "Weight",
      component: WeightTile,
      viewComponent: WeightTileView,
      worldCol: 36,
      worldRow: 30,
      cols: 3,
      rows: 2,
    },
  ],
});
