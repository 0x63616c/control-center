import { defineApp } from "@app-kit";
import { DeployTile, DeployTileView } from "./web";

/**
 * The deploys app manifest (Track C, Wave 2). defineApp is the single source
 * of truth for the tile: id, board placement (copied verbatim from the
 * pre-fold tile-registry entry), and components. Not guest-exposed. The
 * github-poll worker cycle (10s interval) is App-owned in worker.ts. Codegen
 * collects that facet into workers.gen.ts, so apps/worker starts it without a
 * feature-specific import.
 */
export default defineApp({
  id: "tile_deploys",
  tiles: [
    {
      id: "tile_deploys",
      label: "Deploys",
      component: DeployTile,
      viewComponent: DeployTileView,
      worldCol: 34,
      worldRow: 24,
      cols: 4,
      rows: 3,
    },
  ],
});
