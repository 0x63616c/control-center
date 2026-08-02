import { defineApp } from "@app-kit";
import { WakesTile, WakesTileView } from "./web";

/**
 * The Activity app manifest (Track C, Wave 5 fold). Single-tile: one
 * `defineApp` holds the Activity tile. Board placement copied VERBATIM from
 * the pre-fold `tile_wakes` tile-registry entry , NOT home (the Clock is), NOT
 * guest-exposed (the Activity page is PIN-gated / sensitive).
 */
export default defineApp({
  id: "tile_wakes",
  sensitive: true,
  tiles: [
    {
      id: "tile_wakes",
      label: "Activity",
      component: WakesTile,
      viewComponent: WakesTileView,
      worldCol: 34,
      worldRow: 30,
      cols: 2,
      rows: 2,
    },
  ],
});
