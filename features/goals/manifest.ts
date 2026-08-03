import { defineApp } from "@app-kit";
import { GoalsTile, GoalsTileView } from "./web";

export default defineApp({
  id: "tile_goals",
  sensitive: true,
  tiles: [
    {
      id: "tile_goals",
      label: "Goals",
      component: GoalsTile,
      viewComponent: GoalsTileView,
      worldCol: 18,
      worldRow: 27,
      cols: 4,
      rows: 4,
    },
  ],
});
