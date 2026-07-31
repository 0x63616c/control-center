import type { AppManifest } from "@app-kit";
import acManifest from "@features/ac/manifest";
import boothManifest from "@features/booth/manifest";
import ctrlManifest from "@features/ctrl/manifest";
import deploysManifest from "@features/deploys/manifest";
import dogcamManifest from "@features/dogcam/manifest";
import eventsManifest from "@features/events/manifest";
import felogsManifest from "@features/felogs/manifest";
import guestWifiManifest from "@features/guest-wifi/manifest";
import networkManifest from "@features/network/manifest";
import notifManifest from "@features/notif/manifest";
import soundManifest from "@features/sound/manifest";
import teslaManifest from "@features/tesla/manifest";
import tvManifest from "@features/tv/manifest";
import wakesManifest from "@features/wakes/manifest";
import weatherManifest from "@features/weather/manifest";
import weightManifest from "@features/weight/manifest";
import type { ComponentType } from "react";

export type TileRegistryEntry = {
  id: string;
  // The tile's name, used by the minimap hover label, the centered-tile pan
  // label, and the "Open …" aria-label. MUST match the title the tile renders in
  // its TileHeader on the board (e.g. "Weather Now", "Climate · A/C", "Upcoming"),
  // so the minimap label always maps to what the user sees on the tile.
  label: string;
  component: ComponentType;
  viewComponent: ComponentType<never>;
  // Free position in the ONE world, in 0-indexed world-cell coords. A tile may sit
  // ANYWHERE at any size  --  there is no cluster, no grid to fill, no gap/overlap
  // rule against other real tiles. The decorative bento (placeholder-tiles.ts)
  // carves itself around whatever rectangles sit here. Move/resize a tile by
  // editing these four numbers; nothing else needs to change.
  worldCol: number;
  worldRow: number;
  cols: number;
  rows: number;
  // The tile the board opens centered on and resettles to when idle. Exactly one
  // entry sets this (the Clock); the board falls back to the first entry.
  home?: boolean;
  /** A whole-app fresh PIN gate, unlike detail-level `sensitive`. */
  private: boolean;
};

// One entry per real tile, free-placed in the world by world-cell coords. The
// coordinates below are the DEFAULT positions (V4B "Hourly Left" layout), which are
// overridden by board_tile_placement rows in the database. Each tile's worldCol/worldRow
// can be moved by editing these numbers or by creating a board_tile_placement override;
// the bento fill reflows around them automatically.
// The hand-placed, non-feature tiles. Folded features (Track C, C7) own their
// own placement in their manifest and are unioned into TILE_REGISTRY below —
// the Guest Wi-Fi tile used to live here as `tile_guestwifi` but now comes from
// features/guest-wifi/manifest.ts.
//
// EMPTY. Photo Booth was the last hand-placed tile ("tile_booth", 2x2 at col
// 30 / row 22) — it now comes from features/booth/manifest.ts (Track C, final
// tile fold). Every board tile now comes from a feature manifest.
const REGISTRY_ENTRIES: TileRegistryEntry[] = [];

// Folded features (Track C, C7). Each app manifest owns its tile placement; the
// board renders the UNION of the hand-placed registry entries and every feature
// tile. The codegen (scripts/apps-gen) reads the SAME manifests and dedupes a
// registry entry whose id a feature already owns, so each tile has exactly one
// source of truth. Adding a feature = adding its manifest here + the folder.
const FEATURE_MANIFESTS: AppManifest[] = [
  guestWifiManifest,
  networkManifest,
  teslaManifest,
  dogcamManifest,
  weightManifest,
  deploysManifest,
  notifManifest,
  weatherManifest,
  wakesManifest,
  eventsManifest,
  acManifest,
  tvManifest,
  soundManifest,
  ctrlManifest,
  felogsManifest,
  boothManifest,
];

function manifestToEntries(m: AppManifest): TileRegistryEntry[] {
  return m.tiles.map((tile) => {
    const viewComponent = tile.viewComponent;
    if (!viewComponent) {
      throw new Error(`feature manifest ${m.id} tile ${tile.id} has no viewComponent`);
    }
    return {
      id: tile.id,
      label: tile.label,
      component: tile.component,
      viewComponent,
      worldCol: tile.worldCol,
      worldRow: tile.worldRow,
      cols: tile.cols,
      rows: tile.rows,
      private: Boolean(m.private),
      ...(tile.home ? { home: true as const } : {}),
    };
  });
}

export const TILE_REGISTRY: TileRegistryEntry[] = [
  ...REGISTRY_ENTRIES,
  ...FEATURE_MANIFESTS.flatMap(manifestToEntries),
];

// The tile the board opens on and idles back to (the Clock), or the first entry
// if none is flagged. Centralized so Board doesn't hard-code an id.
export const HOME_TILE: TileRegistryEntry = TILE_REGISTRY.find((t) => t.home) ?? TILE_REGISTRY[0];

// Flat lookup: component or viewComponent → registry entry.
// Used by the Storybook BoardDecorator to auto-size any tile story.
const componentMap = new Map<ComponentType | ComponentType<never>, TileRegistryEntry>();
for (const entry of TILE_REGISTRY) {
  componentMap.set(entry.component, entry);
  componentMap.set(entry.viewComponent, entry);
}

export function registryEntryForComponent(
  component: ComponentType | ComponentType<never> | undefined,
): TileRegistryEntry | undefined {
  if (!component) return undefined;
  return componentMap.get(component);
}

export function registryEntryForTileId(tileId: string): TileRegistryEntry | undefined {
  return TILE_REGISTRY.find((entry) => entry.id === tileId);
}
