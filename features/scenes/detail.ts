import { defineTileViews } from "@app-kit";
import { createElement } from "react";
import type { DetailVariant, TileDetailPageEntry } from "@/components/tiles/detail/types";
import { ScenesPage } from "./web";

function useVariants(): { variants: DetailVariant[]; loading: boolean } {
  return {
    loading: false,
    variants: [{ slug: "scenes", label: "Scenes", render: () => createElement(ScenesPage) }],
  };
}

const scenesDetail: TileDetailPageEntry = {
  kind: "page",
  tileId: "tile_scenes",
  title: "Scenes",
  defaultSlug: "scenes",
  useVariants,
};

export const tileViews = defineTileViews([scenesDetail]);
