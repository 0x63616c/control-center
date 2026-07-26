import { defineApp } from "@app-kit";
import { WeightTile, WeightTileView } from "./web";

/**
 * The weight app manifest (Track C, Wave 2). One inline `defineApp` is the
 * single source of truth for this tile: id, board placement, and components.
 * Not guest-exposed.
 *
 * worldRow 34 (moved from the pre-fold registry's row 22 — issue #68): row 22
 * sat just above the resting-viewport top edge, clipped off on its own with
 * dead space beneath it before the home cluster started at row 24. Row 34
 * sits flush against the home cluster's packed bottom edge (every other real
 * tile ends by row 34) instead of floating above it.
 *
 * The weight-ingest interval cycle (apps/api/src/services/weight-service.ts,
 * 15s HA poll) is NOT part of this app — it stays hand-wired in apps/worker,
 * importing this feature's schema/service directly. The S1 job-handler seam
 * only covers queue jobs (notify, youtube_ingest), not interval cycles.
 */
export default defineApp({
  id: "tile_weight",
  tiles: [
    {
      id: "tile_weight",
      label: "Weight",
      component: WeightTile,
      viewComponent: WeightTileView,
      worldCol: 34,
      worldRow: 34,
      cols: 3,
      rows: 2,
    },
  ],
});
