import { defineApp } from "@app-kit";
import { PhotoBoothTile } from "./web";

/**
 * The Photo Booth app manifest (Track C, final tile fold). Single-tile: one
 * `defineApp` holds the Photo Booth tile. NOT home (the Clock is), NOT
 * guest-exposed. Unlike wakes (which had a separate view component), the
 * registry entry used `PhotoBoothTile` for both `component` and
 * `viewComponent`, kept here.
 *
 * worldRow 34 (moved from row 22 — issue #68): see the matching note in
 * features/weight/manifest.ts for why.
 */
export default defineApp({
  id: "tile_booth",
  tiles: [
    {
      id: "tile_booth",
      label: "Photo Booth",
      component: PhotoBoothTile,
      viewComponent: PhotoBoothTile,
      worldCol: 30,
      worldRow: 34,
      cols: 2,
      rows: 2,
    },
  ],
});
