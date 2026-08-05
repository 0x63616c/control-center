import {
  DESK_RF_BONDED_UUID,
  LIGHTS,
  SonosClient,
  type SpotifyClient,
  TOPOLOGY_ANCHOR_IP,
} from "@www/core";
import type { SceneSpeaker } from "./model";

export interface SceneResources {
  lights: Array<{
    entityId: string;
    label: string;
    room: string;
    capabilities: readonly string[];
  }>;
  speakers: { status: "ready"; items: SceneSpeaker[] } | { status: "unavailable"; message: string };
  spotify:
    | {
        status: "ready";
        playlists: Array<{ id: string; name: string; uri: string; imageUrl: string | null }>;
      }
    | { status: "unavailable"; message: string };
}

export async function discoverSpeakers(): Promise<SceneSpeaker[]> {
  const groups = await new SonosClient(TOPOLOGY_ANCHOR_IP).getZoneGroupState();
  const members = groups
    .flatMap((group) => group.members)
    .filter((member) => member.uuid !== DESK_RF_BONDED_UUID);
  const unique = [...new Map(members.map((member) => [member.uuid, member])).values()];
  const speakers = await Promise.all(
    unique.map(async (member) => ({
      uuid: member.uuid,
      name: member.zoneName,
      deviceIp: member.ip,
      volume: await new SonosClient(member.ip).getVolume(),
    })),
  );
  return speakers.sort((a, b) => a.name.localeCompare(b.name));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "integration unavailable";
}

export async function getSceneResources(spotify: SpotifyClient): Promise<SceneResources> {
  const [speakers, browse] = await Promise.allSettled([discoverSpeakers(), spotify.browse()]);
  return {
    lights: LIGHTS.map((light) => ({
      entityId: light.entityId,
      label: light.label,
      room: light.room,
      capabilities: light.capabilities,
    })),
    speakers:
      speakers.status === "fulfilled"
        ? { status: "ready", items: speakers.value }
        : { status: "unavailable", message: errorMessage(speakers.reason) },
    spotify:
      browse.status === "fulfilled"
        ? {
            status: "ready",
            playlists: browse.value.playlists.map((playlist) => ({
              id: playlist.id,
              name: playlist.title,
              uri: playlist.uri,
              imageUrl: playlist.imageUrl,
            })),
          }
        : { status: "unavailable", message: errorMessage(browse.reason) },
  };
}
