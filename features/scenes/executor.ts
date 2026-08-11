import {
  DeviceKind,
  type DeviceLightState,
  type DeviceStateStore,
  type DeviceStateValue,
  LIGHTS,
  type LightEntry,
  LightKind,
} from "@www/core";
import { getLogger } from "@www/logger";
import type {
  LaunchOverrides,
  LightingAction,
  MusicAction,
  ResolvedSceneExecution,
  SceneDefinition,
  ScenePlaylist,
  SceneSpeaker,
} from "./model";
import { PlaylistSelection, SceneActionKind, SceneRunStatus } from "./model";
import type { SceneRepository } from "./repository";

export interface SceneExecutorDependencies {
  readonly ha: {
    isConfigured(): boolean;
    callService(domain: string, service: string, params: Record<string, unknown>): Promise<void>;
  };
  readonly spotify: SceneSpotify;
  readonly deviceStateStore: DeviceStateStore;
  readonly discoverSpeakers: () => Promise<SceneSpeaker[]>;
  readonly random?: () => number;
}

interface SceneSpotify {
  pauseDevice(deviceId: string): Promise<void>;
}

function isDeviceLightState(value: DeviceStateValue | null): value is DeviceLightState {
  return value !== null && "on" in value && typeof value.on === "boolean";
}

function lightingAction(scene: SceneDefinition): LightingAction | null {
  return (
    scene.actions.find(
      (action): action is LightingAction => action.kind === SceneActionKind.Lighting,
    ) ?? null
  );
}

function musicAction(scene: SceneDefinition): MusicAction | null {
  return (
    scene.actions.find((action): action is MusicAction => action.kind === SceneActionKind.Music) ??
    null
  );
}

export function resolvePlaylist(
  action: MusicAction,
  overrideUri: string | undefined,
  random: () => number = Math.random,
): ScenePlaylist {
  if (overrideUri) {
    const selected = action.source.playlists.find((playlist) => playlist.uri === overrideUri);
    if (!selected) throw new Error("The selected playlist is not part of this scene");
    return selected;
  }
  if (action.source.selection === PlaylistSelection.Prompt && action.source.playlists.length > 1) {
    throw new Error("Choose a playlist before starting this scene");
  }
  if (action.source.selection === PlaylistSelection.Random) {
    const index = Math.min(
      action.source.playlists.length - 1,
      Math.floor(random() * action.source.playlists.length),
    );
    const selected = action.source.playlists[index];
    if (!selected) throw new Error("This scene has no playlist to play");
    return selected;
  }
  const first = action.source.playlists[0];
  if (!first) throw new Error("This scene has no playlist to play");
  return first;
}

export function resolveSpeakers(
  action: MusicAction,
  available: readonly SceneSpeaker[],
  overrides: LaunchOverrides["speakers"],
): SceneSpeaker[] {
  const availableByUuid = new Map(available.map((speaker) => [speaker.uuid, speaker]));
  const availableByName = new Map(
    available.map((speaker) => [speaker.name.trim().toLocaleLowerCase(), speaker]),
  );
  if (overrides) {
    const selected = overrides
      .filter((override) => override.enabled)
      .map((override) => {
        const speaker = availableByUuid.get(override.speakerUuid);
        if (!speaker) throw new Error(`Speaker ${override.speakerUuid} is unavailable`);
        return { ...speaker, volume: override.volume };
      });
    if (selected.length === 0) throw new Error("Choose at least one speaker");
    return selected;
  }

  const allTarget = action.outputs.find((output) => output.kind === "all");
  if (allTarget) {
    if (available.length === 0) throw new Error("No Sonos speakers are available");
    return available.map((speaker) => ({ ...speaker, volume: allTarget.volume }));
  }
  const selected = action.outputs.map((output) => {
    if (output.kind !== "speaker") throw new Error("Unsupported speaker target");
    // Existing scenes store the old direct-Sonos UUID. During the HA cutover,
    // preserve those scenes by resolving their stable human room label to the
    // current HA media_player entity.
    const speaker =
      availableByUuid.get(output.speakerUuid) ??
      availableByName.get(output.label.trim().toLocaleLowerCase());
    if (!speaker) throw new Error(`${output.label} is unavailable`);
    return { ...speaker, volume: output.volume };
  });
  if (selected.length === 0) throw new Error("Choose at least one speaker");
  return selected;
}

function resolveLightTargets(action: LightingAction): LightEntry[] {
  if (action.targets.some((target) => target.kind === "all")) return [...LIGHTS];
  const byEntityId = new Map(LIGHTS.map((light) => [light.entityId, light]));
  return action.targets.map((target) => {
    if (target.kind !== "entity") throw new Error("Unsupported light target");
    const light = byEntityId.get(target.entityId);
    if (!light) throw new Error(`Light ${target.entityId} is not configured`);
    return light;
  });
}

async function applyLighting(
  action: LightingAction,
  ha: { isConfigured(): boolean },
  store: DeviceStateStore,
): Promise<void> {
  if (!ha.isConfigured()) throw new Error("Home Assistant is not configured");
  const targets = resolveLightTargets(action);
  const existing = await store.list({ entityIds: targets.map((target) => target.entityId) });
  const byEntityId = new Map(existing.map((row) => [row.entityId, row]));
  await Promise.all(
    targets.map(async (target) => {
      const previous = byEntityId.get(target.entityId)?.desiredState;
      let base: DeviceLightState | null = null;
      const candidate = previous ?? null;
      if (isDeviceLightState(candidate)) base = candidate;
      const supportsBrightness = target.capabilities.includes("brightness");
      const supportsRgb = target.capabilities.includes("rgb");
      const supportsTemperature = target.capabilities.includes("colorTemp");
      const desired: DeviceLightState = action.power
        ? {
            on: true,
            ...(supportsBrightness
              ? { brightness: Math.round((action.brightness / 100) * 255) }
              : {}),
            ...(action.color.kind === "rgb" && supportsRgb
              ? { color: { rgb: [action.color.red, action.color.green, action.color.blue] } }
              : action.color.kind === "temperature" && supportsTemperature
                ? { color: { kelvin: action.color.kelvin } }
                : base?.color
                  ? { color: base.color }
                  : {}),
            transitionSeconds: action.transitionSeconds,
          }
        : { ...(base ?? {}), on: false, transitionSeconds: action.transitionSeconds };
      await store.upsertDesired({
        id: target.id,
        kind: target.kind === LightKind.Lamp ? DeviceKind.Light : DeviceKind.Switch,
        entityId: target.entityId,
        domain: target.domain,
        label: target.label,
        desired,
      });
    }),
  );
}

async function groupAndSetVolumes(
  speakers: readonly SceneSpeaker[],
  ha: SceneExecutorDependencies["ha"],
): Promise<SceneSpeaker> {
  const coordinator = speakers[0];
  if (!coordinator) throw new Error("Choose at least one speaker");

  // HA owns grouping. Unjoin targets first so old groups cannot leak into a scene.
  await Promise.all(
    speakers.map((speaker) =>
      ha.callService("media_player", "unjoin", { entity_id: speaker.deviceIp }),
    ),
  );
  if (speakers.length > 1) {
    await ha.callService("media_player", "join", {
      entity_id: coordinator.deviceIp,
      group_members: speakers.slice(1).map((speaker) => speaker.deviceIp),
    });
  }
  await Promise.all(
    speakers.map((speaker) =>
      ha.callService("media_player", "volume_set", {
        entity_id: speaker.deviceIp,
        volume_level: speaker.volume / 100,
      }),
    ),
  );
  return coordinator;
}

export async function executeScene(
  scene: SceneDefinition,
  overrides: LaunchOverrides,
  deps: SceneExecutorDependencies,
): Promise<ResolvedSceneExecution> {
  const resolved = await prepareScene(scene, overrides, deps);
  await executePreparedScene(scene, resolved, deps);
  return resolved;
}

/** Resolves every external dependency before the first household device is mutated. */
export async function prepareScene(
  scene: SceneDefinition,
  overrides: LaunchOverrides,
  deps: SceneExecutorDependencies,
): Promise<ResolvedSceneExecution> {
  const lighting = lightingAction(scene);
  const music = musicAction(scene);
  let playlist: ScenePlaylist | null = null;
  let speakers: SceneSpeaker[] = [];
  let mediaPlayerEntityId: string | null = null;

  if (lighting) {
    if (!deps.ha.isConfigured()) throw new Error("Home Assistant is not configured");
    resolveLightTargets(lighting);
  }
  if (music) {
    playlist = resolvePlaylist(music, overrides.playlistUri, deps.random);
    speakers = resolveSpeakers(music, await deps.discoverSpeakers(), overrides.speakers);
    const coordinator = speakers[0];
    if (!coordinator) throw new Error("Choose at least one speaker");
    mediaPlayerEntityId = coordinator.deviceIp;
  }

  return { sceneName: scene.name, playlist, speakers, lighting, mediaPlayerEntityId };
}

async function executePreparedScene(
  scene: SceneDefinition,
  resolved: ResolvedSceneExecution,
  deps: SceneExecutorDependencies,
): Promise<void> {
  if (resolved.lighting) {
    await applyLighting(resolved.lighting, deps.ha, deps.deviceStateStore);
  }
  const music = musicAction(scene);
  if (!music || !resolved.playlist || !resolved.mediaPlayerEntityId) return;
  await groupAndSetVolumes(resolved.speakers, deps.ha);
  await deps.ha.callService("media_player", "shuffle_set", {
    entity_id: resolved.mediaPlayerEntityId,
    shuffle: music.source.shuffleTracks,
  });
  await deps.ha.callService("media_player", "play_media", {
    entity_id: resolved.mediaPlayerEntityId,
    media_content_id: resolved.playlist.uri,
    media_content_type: "playlist",
  });
}

export async function launchScene(
  repository: SceneRepository,
  scene: SceneDefinition,
  overrides: LaunchOverrides,
  deps: SceneExecutorDependencies,
  prepared?: ResolvedSceneExecution,
) {
  const run = await repository.startRun(scene.id, scene.name);
  try {
    const resolved = prepared ?? (await prepareScene(scene, overrides, deps));
    await executePreparedScene(scene, resolved, deps);
    getLogger().info(
      { sceneId: scene.id, sceneRunId: run.id, speakerCount: resolved.speakers.length },
      "scene started",
    );
    return repository.finishRun(run.id, SceneRunStatus.Running, resolved);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scene launch failed";
    getLogger().error({ sceneId: scene.id, sceneRunId: run.id, err: error }, "scene failed");
    await repository.finishRun(run.id, SceneRunStatus.Failed, null, message);
    throw error;
  }
}

export async function stopScene(
  repository: SceneRepository,
  runId: string,
  resolved: ResolvedSceneExecution | null,
  ha: Pick<SceneExecutorDependencies["ha"], "callService">,
) {
  if (resolved?.mediaPlayerEntityId) {
    await ha.callService("media_player", "media_pause", {
      entity_id: resolved.mediaPlayerEntityId,
    });
  }
  return repository.finishRun(runId, SceneRunStatus.Stopped, resolved);
}
