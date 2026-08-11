import { type HomeAssistantClient, LIGHTS, type SpotifyClient } from "@www/core";
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

export async function discoverSpeakers(
  ha: Pick<HomeAssistantClient, "getEntities" | "isConfigured">,
): Promise<SceneSpeaker[]> {
  if (!ha.isConfigured()) throw new Error("Home Assistant is not configured");
  const entities = await ha.getEntities("media_player");
  const speakers = entities.flatMap((entity): SceneSpeaker[] => {
    const members = entity.attributes.group_members;
    if (!Array.isArray(members) || !members.every((member) => typeof member === "string"))
      return [];
    const volumeLevel = entity.attributes.volume_level;
    const friendlyName = entity.attributes.friendly_name;
    return [
      {
        // HA entity ids replace transient Sonos LAN identity for all new scenes.
        uuid: entity.entity_id,
        name:
          typeof friendlyName === "string"
            ? friendlyName
            : entity.entity_id.replace(/^media_player\./, ""),
        deviceIp: entity.entity_id,
        volume: typeof volumeLevel === "number" ? Math.round(volumeLevel * 100) : 0,
      },
    ];
  });
  return speakers.sort((a, b) => a.name.localeCompare(b.name));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "integration unavailable";
}

export async function getSceneResources(
  ha: Pick<HomeAssistantClient, "getEntities" | "isConfigured">,
  spotify: SpotifyClient,
): Promise<SceneResources> {
  const [speakers, browse] = await Promise.allSettled([discoverSpeakers(ha), spotify.browse()]);
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
