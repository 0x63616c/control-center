import { defineApp } from "@app-kit";
import { GuestWifiTile, GuestWifiTileView } from "./web";

/**
 * The guest-wifi app manifest (Track C, C7 — the fold canary). One inline
 * `defineApp` is the single source of truth for this tile: its id, board
 * placement, and the fact that it is reachable by unauthenticated LAN guests
 * (`guestExposed`).
 *
 * worldRow 34 (moved from row 22 — issue #68): see the matching note in
 * features/weight/manifest.ts for why.
 *
 * The codegen collects this manifest from `features/*` /manifest.ts` and unions
 * it with the tile-registry leftovers (D2). `apps/web`'s tile-registry imports
 * this manifest so the board still renders the tile; the id is deduped so the
 * feature is the tile's only source in the generated model.
 *
 * `guestExposed: true` MUST agree with the hand-owned `features/guest-exposed.ts`
 * allowlist or the codegen validator throws — widening the guest surface is a
 * deliberate, security-reviewed edit, never an implicit flag flip.
 */
export default defineApp({
  id: "tile_guestwifi",
  tiles: [
    {
      id: "tile_guestwifi",
      label: "Guest",
      component: GuestWifiTile,
      viewComponent: GuestWifiTileView,
      worldCol: 28,
      worldRow: 34,
      cols: 2,
      rows: 2,
    },
  ],
  guestExposed: true,
});
