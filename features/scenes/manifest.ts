import { defineApp } from "@app-kit";
import { ScenesTile, ScenesTileView } from "./web";

export default defineApp({
  id: "tile_scenes",
  sensitive: true,
  tiles: [
    {
      id: "tile_scenes",
      label: "Scenes",
      component: ScenesTile,
      viewComponent: ScenesTileView,
      worldCol: 18,
      worldRow: 31,
      cols: 4,
      rows: 3,
    },
  ],
});
