import { defineApp } from "@app-kit";
import { ClimateTile, ClimateTileView } from "./web";

/**
 * The climate (A/C) app manifest (Track C, Phase 3 — F-devstate ac slice). A
 * single-tile fold: one defineApp holds the Climate · A/C tile. Board placement
 * copied verbatim from the pre-fold tile-registry `tile_ac` entry. Not `home`
 * (the Clock is). Not guest-exposed. The App owns its climate-enforcer cadence
 * through worker.ts; codegen registers it with the worker runtime. It owns no
 * table because it reads the shared @www/core device_state row.
 */
export default defineApp({
  id: "tile_ac",
  tiles: [
    {
      id: "tile_ac",
      label: "Climate · A/C",
      component: ClimateTile,
      viewComponent: ClimateTileView,
      worldCol: 30,
      worldRow: 24,
      cols: 4,
      rows: 3,
    },
  ],
});
