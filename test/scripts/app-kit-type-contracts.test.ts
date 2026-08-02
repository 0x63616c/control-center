import { defineTileViews } from "../../app-kit/define-facets";

// This file is included by tsconfig.config.json, so `bun run typecheck`
// verifies that Tile View facets cannot redeclare App-owned access policy.
// @ts-expect-error Panel access belongs to defineApp(), not a Tile View facet.
defineTileViews([{ tileId: "tile_invalid", sensitive: true }]);
