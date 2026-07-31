import { defineApp } from "@app-kit";
import { PhotoBoothTile } from "./web";

/**
 * The Photo Booth app manifest (Track C, final tile fold). Single-tile: one
 * `defineApp` holds the Photo Booth tile. Board placement copied VERBATIM from
 * the pre-fold `tile_booth` tile-registry entry — NOT home (the Clock is), NOT
 * guest-exposed. Unlike wakes (which had a separate view component), the
 * registry entry used `PhotoBoothTile` for both `component` and
 * `viewComponent`, kept here.
 */
export default defineApp({
  id: "tile_booth",
  private: true,
  tiles: [
    {
      id: "tile_booth",
      label: "Photo Booth",
      component: PhotoBoothTile,
      viewComponent: PhotoBoothTile,
      worldCol: 30,
      worldRow: 22,
      cols: 2,
      rows: 2,
    },
  ],
});
