import type { ComponentType } from "react";
import type { AppManifest } from "./define-app";
import type { TileViewDeclaration } from "./define-facets";

export interface TileAccessPolicy {
  /** Reuse the shared Panel PIN Session until it expires. */
  readonly requiresSessionUnlock: boolean;
  /** Prompt once per opening, even when the shared Panel session is unlocked. */
  readonly requiresFreshUnlock: boolean;
}

export interface TileRegistryEntry {
  readonly id: string;
  readonly label: string;
  readonly component: ComponentType;
  readonly viewComponent: ComponentType<never>;
  readonly worldCol: number;
  readonly worldRow: number;
  readonly cols: number;
  readonly rows: number;
  readonly home?: boolean;
  /** Normalized from the owning App manifest. */
  readonly access: TileAccessPolicy;
}

/**
 * Build the web runtime from the generated, statically imported App aggregate.
 * Codegen owns discovery; this module owns the Board and Tile View lookup rules.
 */
export function createWebRegistry<TileView extends TileViewDeclaration>(
  manifests: readonly AppManifest[],
  tileViews: readonly TileView[],
) {
  const TILE_REGISTRY: TileRegistryEntry[] = manifests.flatMap((manifest) => {
    if (manifest.sensitive && manifest.private) {
      throw new Error(`App ${manifest.id} cannot be both sensitive and private`);
    }
    return manifest.tiles.map((tile) => {
      if (!tile.viewComponent) {
        throw new Error(`App ${manifest.id} Tile ${tile.id} has no viewComponent`);
      }
      return {
        id: tile.id,
        label: tile.label,
        component: tile.component,
        viewComponent: tile.viewComponent,
        worldCol: tile.worldCol,
        worldRow: tile.worldRow,
        cols: tile.cols,
        rows: tile.rows,
        access: {
          requiresSessionUnlock: Boolean(manifest.sensitive),
          requiresFreshUnlock: Boolean(manifest.private),
        },
        ...(tile.home ? { home: true as const } : {}),
      };
    });
  });

  const HOME_TILE = TILE_REGISTRY.find((tile) => tile.home) ?? TILE_REGISTRY[0];
  if (!HOME_TILE) throw new Error("App web registry has no Tiles");

  const byComponent = new Map<ComponentType | ComponentType<never>, TileRegistryEntry>();
  const byTileId = new Map<string, TileRegistryEntry>();
  for (const entry of TILE_REGISTRY) {
    byComponent.set(entry.component, entry);
    byComponent.set(entry.viewComponent, entry);
    byTileId.set(entry.id, entry);
  }

  const tileViewsById = new Map(tileViews.map((entry) => [entry.tileId, entry]));

  return {
    TILE_REGISTRY,
    HOME_TILE,
    registryEntryForComponent: (
      component: ComponentType | ComponentType<never> | undefined,
    ): TileRegistryEntry | undefined => (component ? byComponent.get(component) : undefined),
    registryEntryForTileId: (tileId: string): TileRegistryEntry | undefined => byTileId.get(tileId),
    accessFor: (tileId: string): TileAccessPolicy => {
      const entry = byTileId.get(tileId);
      if (!entry) throw new Error(`App web registry received unknown Tile '${tileId}'`);
      return entry.access;
    },
    getTileDetailEntry: (tileId: string): TileView | undefined => tileViewsById.get(tileId),
  };
}
