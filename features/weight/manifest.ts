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
 * The weight-ingest interval cycle (apps/api/src/services/weight-service.ts,
 * 15s HA poll) is NOT part of this app — it stays hand-wired in apps/worker,
 * importing this feature's schema/service directly. The S1 job-handler seam
 * only covers queue jobs (such as notify), not interval cycles.
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
