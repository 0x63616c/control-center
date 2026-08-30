/**
 * Home Assistant media-player writes for the Sound System.
 *
 * The procedure names remain temporarily stable for the web client, but every
 * command goes through HA's Sonos integration. There is deliberately no SOAP
 * fallback: a failed HA command is a visible failure, never a second writer.
 */
import { type HomeAssistantClient, haFromConfig } from "@www/core";
import { config } from "./config";

const ha = haFromConfig(config);

type HaWriter = Pick<HomeAssistantClient, "callService">;

export async function sonosSetVolume(
  { deviceIp, volume }: { deviceIp: string; volume: number },
  client: HaWriter = ha,
): Promise<void> {
  await client.callService("media_player", "volume_set", {
    entity_id: deviceIp,
    volume_level: volume / 100,
  });
}

export async function sonosSetMute(
  { deviceIp, muted }: { deviceIp: string; muted: boolean },
  client: HaWriter = ha,
): Promise<void> {
  await client.callService("media_player", "volume_mute", {
    entity_id: deviceIp,
    is_volume_muted: muted,
  });
}

export async function sonosTransport(
  {
    coordinatorIp,
    command,
  }: { coordinatorIp: string; command: "play" | "pause" | "next" | "previous" },
  client: HaWriter = ha,
): Promise<void> {
  const service =
    command === "play"
      ? "media_play"
      : command === "pause"
        ? "media_pause"
        : `media_${command}_track`;
  await client.callService("media_player", service, { entity_id: coordinatorIp });
}

/** Join a room to an HA media-player leader. */
export async function sonosGroupJoin(
  { memberIp, coordinatorUuid }: { memberIp: string; coordinatorUuid: string },
  client: HaWriter = ha,
): Promise<void> {
  await client.callService("media_player", "join", {
    entity_id: coordinatorUuid,
    group_members: [memberIp],
  });
}

/** Join multiple rooms to one HA media-player leader in a single command. */
export async function sonosGroupJoinAll(
  {
    coordinatorEntityId,
    memberEntityIds,
  }: { coordinatorEntityId: string; memberEntityIds: readonly string[] },
  client: HaWriter = ha,
): Promise<void> {
  await client.callService("media_player", "join", {
    entity_id: coordinatorEntityId,
    group_members: memberEntityIds,
  });
}

/** Make a room standalone through HA. */
export async function sonosGroupLeave(
  { memberIp }: { memberIp: string; memberUuid: string },
  client: HaWriter = ha,
): Promise<void> {
  await client.callService("media_player", "unjoin", { entity_id: memberIp });
}

export async function sonosSetLineIn(
  { deviceIp }: { deviceIp: string; sourceUuid: string },
  client: HaWriter = ha,
): Promise<void> {
  await client.callService("media_player", "select_source", {
    entity_id: deviceIp,
    source: "Line-in",
  });
}

export async function sonosGrabTvToBeam(
  { beamIp }: { beamIp: string; beamUuid: string },
  client: HaWriter = ha,
): Promise<void> {
  await client.callService("media_player", "select_source", { entity_id: beamIp, source: "TV" });
}

/** Play a Spotify (or Sonos) URI via HA, rather than Spotify Connect device discovery. */
export async function playMediaOnRoom(
  { entityId, uri }: { entityId: string; uri: string },
  client: HaWriter = ha,
): Promise<void> {
  await client.callService("media_player", "play_media", {
    entity_id: entityId,
    media_content_id: uri,
    media_content_type: uri.startsWith("spotify:playlist:") ? "playlist" : "music",
  });
}
