/**
 * Quick Play tile , live wiring for its two detail-page variants: "Favorites"
 * (Sonos favorites cover grid) and "Spotify" (browse rows).
 *
 * Spotify browsing remains useful, while every playback request routes through
 * Home Assistant's media-player service for the selected room.
 */

import type { DetailVariant, TileDetailPageEntry } from "@/components/tiles/detail/types";
import { POLL } from "@/lib/hooks";
import { trpc } from "@/lib/trpc";
import { SpotifyModal } from "../SpotifyModal";

function useQuickPlayVariants(): { variants: DetailVariant[]; loading: boolean } {
  const { data: spotifyData } = trpc.sound.spotify.browse.useQuery(undefined, {
    refetchInterval: POLL.quickPlay,
  });
  const { data: soundData } = trpc.sound.soundSystem.useQuery(undefined, {
    refetchInterval: POLL.quickPlay,
  });

  const playMediaMutation = trpc.sound.playMedia.useMutation();

  // Ready as soon as either content source resolves , the same gate the tile
  // face uses for its merged rail.
  if (spotifyData === undefined) {
    return { variants: [], loading: true };
  }

  const zones = (soundData?.rooms ?? []).map((r) => ({ name: r.name, entityId: r.deviceIp }));

  function playOnRoom(uri: string, entityId: string) {
    playMediaMutation.mutate({ entityId, uri });
  }

  const variants: DetailVariant[] = [
    {
      slug: "spotify",
      label: "Spotify",
      render: () => (
        <SpotifyModal
          recentlyPlayed={(spotifyData?.recentlyPlayed ?? []).map((t) => ({
            ...t,
            albumArtUrl: t.albumArtUrl ?? null,
          }))}
          playlists={(spotifyData?.playlists ?? []).map((p) => ({
            ...p,
            albumArtUrl: p.imageUrl ?? null,
          }))}
          zones={zones}
          onPlay={playOnRoom}
        />
      ),
    },
  ];

  return { variants, loading: false };
}

export const quickPlayDetailEntry: TileDetailPageEntry = {
  kind: "page",
  tileId: "tile_quickplay",
  title: "Quick Play",
  defaultSlug: "spotify",
  useVariants: useQuickPlayVariants,
};
