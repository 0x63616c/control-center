/**
 * Sonos sound-system service (www-51hf.9, reshaped in www-7u9z).
 *
 * Returns one room per PHYSICAL player , Living Room, Desk, Bedroom, Bathroom,
 * Kitchen , each with its OWN volume/mute/IP, plus the coordinator UUID of the
 * group it currently belongs to (so the UI can gang grouped rooms together).
 * Topology is read FRESH on every call. The bonded Desk RF satellite
 * (RINCON_804AF288FDBA01400) is collapsed into the Desk room so only 5 rooms
 * show, not 6.
 *
 * Why per-player, not per-group: a Sonos group is named after its coordinator,
 * so a "play everywhere" group would collapse the whole house into a single
 * fader labeled after one room. Per-player rooms always show all 5; grouping is
 * expressed by a shared `coordinatorUuid` and ganged in the mixer UI.
 *
 * Design rules:
 *  - THROW on any SonosClient failure (never return fabricated data, A3).
 *  - Never cache topology , grouping is volatile (TV power reshapes it, A11).
 *  - Volume/mute are per-device (each player owns them even while grouped);
 *    transport state belongs to the group and is read from the coordinator.
 */

import { type HaEntity, type HomeAssistantClient, haFromConfig } from "@www/core";
import { config } from "./config";

// Stable display order for the rooms, so faders never reshuffle between polls. Rooms not in this
// list (e.g. a new speaker) sort after the known ones, alphabetically.
const ROOM_ORDER = ["Living Room", "Desk", "Bedroom", "Bathroom", "Kitchen"];

function roomRank(name: string): number {
  const i = ROOM_ORDER.indexOf(name);
  return i === -1 ? ROOM_ORDER.length : i;
}

type SourceKind = "line-in" | "tv" | "spotify" | "airplay" | "other" | "idle";

const SOURCE_LABELS: Record<SourceKind, string | null> = {
  "line-in": "Line-In",
  tv: "TV",
  spotify: "Spotify",
  airplay: "AirPlay",
  other: null,
  idle: null,
};

/** @public , shape for the soundSystem tRPC query response; consumed by the media router and the Sound System tile */
export interface SoundSystemRoom {
  /** Human-readable room name (this player's ZoneName). */
  name: string;
  /** This player's own UUID , the stable identity key for the room. */
  uuid: string;
  /** This player's LAN IP , the target for per-room volume/mute writes. */
  deviceIp: string;
  /** Coordinator UUID of the group this room currently belongs to; rooms sharing it are grouped. */
  coordinatorUuid: string;
  /** All player UUIDs in this room's group (includes the bonded RF satellite). */
  memberUuids: string[];
  /** Whether this room is its own group's coordinator. */
  isCoordinator: boolean;
  /** This player's own volume, 0-100. */
  volume: number;
  /** Whether this player is muted. */
  muted: boolean;
  /** Group transport state from the coordinator: "PLAYING" | "PAUSED_PLAYBACK" | "STOPPED". */
  transportState: string;
  /** Human source label from the group coordinator's stream, null when idle/unknown. */
  sourceLabel: string | null;
  /** Classified source kind of this room's group (coordinator's CurrentURI). */
  sourceKind: SourceKind;
  /** Now-playing metadata from the group coordinator; null when the source has none. */
  trackTitle: string | null;
  trackArtist: string | null;
  albumArtUri: string | null;
  /** HA reports unavailable separately from whether a player is currently playing. */
  availability: "available" | "unavailable" | "unknown";
  /** `Standalone` or the room this player follows. Never rendered as ambiguous “off”. */
  groupStatus: string;
}

export interface SoundSystemResult {
  rooms: SoundSystemRoom[];
  diagnostics: {
    controlPlane: "home-assistant";
    queriedAt: string;
    message: string;
  };
}

const ha = haFromConfig(config);

function stringAttr(entity: HaEntity, key: string): string | null {
  const value = entity.attributes[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArrayAttr(entity: HaEntity, key: string): string[] {
  const value = entity.attributes[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function sourceKind(source: string | null): SourceKind {
  const value = source?.toLocaleLowerCase() ?? "";
  if (!value || value === "idle") return "idle";
  if (value.includes("line")) return "line-in";
  if (value.includes("tv")) return "tv";
  if (value.includes("spotify")) return "spotify";
  if (value.includes("airplay")) return "airplay";
  return "other";
}

function transportState(state: string): string {
  switch (state) {
    case "playing":
      return "PLAYING";
    case "paused":
      return "PAUSED_PLAYBACK";
    case "unavailable":
      return "UNAVAILABLE";
    case "unknown":
      return "UNKNOWN";
    default:
      return "STOPPED";
  }
}

/** Convert HA's media-player state into the stable UI shape without any Sonos SOAP calls. */
export function roomFromHaEntity(entity: HaEntity): SoundSystemRoom | null {
  const memberUuids = stringArrayAttr(entity, "group_members");
  // Sonos entities expose group_members. This deliberately excludes TVs and other HA media players.
  if (memberUuids.length === 0) return null;
  const uuid = entity.entity_id;
  const coordinatorUuid = memberUuids[0] ?? uuid;
  const source = stringAttr(entity, "source");
  const kind = sourceKind(source);
  const volumeLevel = entity.attributes.volume_level;
  const volume = typeof volumeLevel === "number" ? Math.round(volumeLevel * 100) : 0;
  const muted = entity.attributes.is_volume_muted === true;
  const name = stringAttr(entity, "friendly_name") ?? uuid.replace(/^media_player\./, "");
  const coordinatorName = coordinatorUuid.replace(/^media_player\./, "");
  return {
    name,
    // These legacy field names are kept for the existing web component; their value is now the HA entity id.
    uuid,
    deviceIp: uuid,
    coordinatorUuid,
    memberUuids,
    isCoordinator: coordinatorUuid === uuid,
    volume,
    muted,
    transportState: transportState(entity.state),
    sourceLabel: SOURCE_LABELS[kind] ?? source,
    sourceKind: kind,
    trackTitle: stringAttr(entity, "media_title"),
    trackArtist: stringAttr(entity, "media_artist"),
    albumArtUri: stringAttr(entity, "entity_picture"),
    availability:
      entity.state === "unavailable"
        ? "unavailable"
        : entity.state === "unknown"
          ? "unknown"
          : "available",
    groupStatus: coordinatorUuid === uuid ? "Standalone" : `Following ${coordinatorName}`,
  };
}

/**
 * Fetches the current Sonos sound system state.
 * Reads topology fresh every call , never caches grouping.
 * Throws the Home Assistant error unchanged, so the panel can surface the real control-plane failure.
 */
export async function getSoundSystem(
  client: Pick<HomeAssistantClient, "getEntities" | "isConfigured"> = ha,
): Promise<SoundSystemResult> {
  if (!client.isConfigured()) throw new Error("Home Assistant is not configured");
  const rooms = (await client.getEntities("media_player"))
    .map(roomFromHaEntity)
    .filter((room): room is SoundSystemRoom => room !== null);
  rooms.sort((a, b) => roomRank(a.name) - roomRank(b.name) || a.name.localeCompare(b.name));
  return {
    rooms,
    diagnostics: {
      controlPlane: "home-assistant",
      queriedAt: new Date().toISOString(),
      message:
        rooms.length > 0
          ? `${rooms.length} Sonos room${rooms.length === 1 ? "" : "s"} reported by Home Assistant`
          : "Home Assistant returned no Sonos media-player entities",
    },
  };
}
