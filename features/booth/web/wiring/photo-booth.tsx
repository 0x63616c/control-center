/**
 * Photo booth tile , live wiring for its single full-bleed detail page (the
 * camera ⇄ gallery pager). Follows the Activity wiring shape: the hook runs the
 * `boothPhotos` queries only while the page is open, and hands the pager plain
 * data (groups + a `photoUrl` builder) plus a remove callback.
 *
 * The entry is `chrome: "none"` , the camera wants edge-to-edge, so the host
 * skips its PageHeader + padded scroll region and the page owns its own chrome
 * (the camera renders a full-bleed frame with a top-left close; the gallery
 * renders its own sticky PageHeader). The camera must appear instantly, so the
 * hook never blocks the page on the list query (`loading: false` always) , the
 * gallery simply shows its empty state until the first list resolves.
 *
 * Remove is soft under the hood (bytes stay on disk); `remove` invalidates the
 * whole `list` key on settle so the grid re-settles. The manifest's private
 * gate protects this whole surface before its camera or gallery mounts.
 */

import type { DetailVariant, TileDetailPageEntry } from "@/components/tiles/detail/types";
import { POLL } from "@/lib/hooks";
import { closeTileDetail } from "@/lib/tile-detail-store";
import { trpc } from "@/lib/trpc";
import { PhotoBoothPager } from "../PhotoBoothPager";

/** The /media/booth-photos/ serve route (mirrors wake photos' /media path). */
function boothPhotoUrl(path: string): string {
  return `/media/booth-photos/${path}`;
}

function usePhotoBoothVariants(): { variants: DetailVariant[]; loading: boolean } {
  const utils = trpc.useUtils();
  const listing = trpc.boothPhotos.list.useQuery(undefined, {
    refetchInterval: POLL.wakePhotos,
  });
  const invalidate = () => {
    void utils.boothPhotos.list.invalidate();
  };
  const removeMutation = trpc.boothPhotos.remove.useMutation({ onSettled: invalidate });

  const groups = listing.data?.groups ?? [];

  const variants: DetailVariant[] = [
    {
      slug: "booth",
      label: "Photo Booth",
      render: () => (
        <PhotoBoothPager
          groups={groups}
          photoUrl={boothPhotoUrl}
          onRemove={(groupId) => removeMutation.mutate({ groupId })}
          onClose={closeTileDetail}
          // Uploads bypass tRPC (raw POST), so nothing invalidates the listing
          // on its own , without this a shot only appears on the next 60s poll.
          onCaptured={invalidate}
        />
      ),
    },
  ];

  // Never block the page on the list , the camera lands first and must be
  // instant; the gallery reads `groups` live once it resolves.
  return { variants, loading: false };
}

export const photoBoothDetailEntry: TileDetailPageEntry = {
  kind: "page",
  tileId: "tile_booth",
  title: "Photo Booth",
  chrome: "none",
  defaultSlug: "booth",
  useVariants: usePhotoBoothVariants,
};
