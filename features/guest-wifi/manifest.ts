import { defineApp } from "@app-kit";
import { GuestWifiTile, GuestWifiTileView } from "./web";

/**
 * The guest-wifi app manifest (Track C, C7 — the fold canary). One inline
 * `defineApp` is the single source of truth for this tile: its id, board
 * placement (copied verbatim from the pre-fold tile-registry entry), and the
 * fact that it is reachable by unauthenticated LAN guests (`guestExposed`).
 *
 * Codegen discovers this manifest by folder convention and emits it into the
 * static web runtime consumed by the Board.
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
      worldRow: 22,
      cols: 2,
      rows: 2,
    },
  ],
  guestExposed: true,
});
