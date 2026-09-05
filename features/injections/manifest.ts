import { defineApp } from "@app-kit";
import { InjectionTile, InjectionTileView } from "./web";
export default defineApp({
  id: "tile_injections",
  sensitive: true,
  tiles: [
    {
      id: "tile_injections",
      label: "Injection tracker",
      component: InjectionTile,
      viewComponent: InjectionTileView,
      worldCol: 39,
      worldRow: 30,
      cols: 3,
      rows: 4,
    },
  ],
});
