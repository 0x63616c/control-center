/**
 * Sound System tile , live wiring for its single detail-page variant (the
 * Sonos Groups patch-bay).
 *
 * Data: trpc.sound.soundSystem, polled here while the page is open (same query
 * key as the tile face, so react-query dedupes the fetch). GroupsModal is the
 * existing container that owns the join/leave/grab mutations; it needs
 * dataUpdatedAt to gate useGroupMembership's stale-poll reconcile.
 */

import type { DetailVariant, TileDetailPageEntry } from "@/components/tiles/detail/types";
import { POLL } from "@/lib/hooks";
import { trpc } from "@/lib/trpc";
import { GroupsModal } from "../GroupsModal";

function useSoundVariants(): { variants: DetailVariant[]; loading: boolean } {
  const query = trpc.sound.soundSystem.useQuery(undefined, {
    refetchInterval: POLL.soundSystem,
  });
  const snapshot = query.data;
  if (!snapshot && !query.isError) return { variants: [], loading: true };
  const diagnostics = snapshot
    ? { kind: "ready" as const, ...snapshot.diagnostics }
    : {
        kind: "error" as const,
        message:
          query.error instanceof Error ? query.error.message : "Unable to query Home Assistant",
      };

  const variants: DetailVariant[] = [
    {
      slug: "detail",
      label: "Sound System",
      render: () => <GroupsModal rooms={snapshot?.rooms ?? []} diagnostics={diagnostics} />,
    },
  ];

  return { variants, loading: false };
}

export const soundDetailEntry: TileDetailPageEntry = {
  kind: "page",
  tileId: "tile_sound",
  title: "Sound System",
  defaultSlug: "detail",
  useVariants: useSoundVariants,
};
