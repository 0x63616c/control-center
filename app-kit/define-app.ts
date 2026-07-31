import type { ComponentType } from "react";

export const APP_BRAND = Symbol.for("app-kit.app");

export interface TileSpec {
  /** The TILE id (e.g. "tile_weath"). Distinct from the owning App id; a
   *  multi-tile App's tiles each carry their own. The board, board_tile_placement
   *  rows, placeholder-tiles bento, and minimap all key on this. */
  id: string;
  label: string;
  component: ComponentType;
  // Matches the real tile-registry field (an identity-only slot: the full-screen
  // view is looked up by identity, never rendered generically), so it is typed
  // ComponentType<never> — which accepts a prop-taking view like a status tile.
  viewComponent?: ComponentType<never>;
  worldCol: number;
  worldRow: number;
  cols: number;
  rows: number;
  /** The one tile the board opens on and idles back to. Exactly one tile across
   *  ALL apps sets this (validator-enforced). */
  home?: boolean;
}
export interface AppManifest {
  /** The APP / domain id: owns the router-key namespace, its table(s), the
   *  guestExposed allowlist match, and the feature folder. For a single-tile App
   *  this equals its one tile's id. */
  id: string;
  tiles: TileSpec[];
  guestExposed?: boolean;
  sensitive?: boolean;
  /** Require a fresh PIN for every app opening, independent of session unlock. */
  private?: boolean;
}

/** Brand + pass-through. The manifest is authored inline; codegen collects it. */
export function defineApp(m: AppManifest): AppManifest {
  return Object.assign(Object.create(null), m, { [APP_BRAND]: true }) as AppManifest;
}
