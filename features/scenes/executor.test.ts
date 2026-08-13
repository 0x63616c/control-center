import { createInMemoryDeviceStateStore, LIGHTS } from "@www/core";
import { describe, expect, it, vi } from "vitest";
import { executeScene, prepareScene, resolvePlaylist, resolveSpeakers } from "./executor";
import type { MusicAction, SceneDefinition, SceneSpeaker } from "./model";

const music: MusicAction = {
  kind: "music",
  source: {
    kind: "spotify",
    playlists: [{ name: "One", uri: "spotify:playlist:one" }],
    selection: "fixed",
    shuffleTracks: true,
  },
  outputs: [{ kind: "all", volume: 25 }],
};
const speakers: SceneSpeaker[] = [
  {
    uuid: "media_player.living_room",
    name: "Living Room",
    deviceIp: "media_player.living_room",
    volume: 12,
  },
  { uuid: "media_player.kitchen", name: "Kitchen", deviceIp: "media_player.kitchen", volume: 15 },
];

describe("scene launch resolution", () => {
  it("keeps playlist and speaker selection deterministic", () => {
    expect(resolvePlaylist(music, undefined).name).toBe("One");
    expect(resolveSpeakers(music, speakers, undefined)).toEqual(
      speakers.map((speaker) => ({ ...speaker, volume: 25 })),
    );
  });

  it("resolves a pre-cutover named scene by its room label", () => {
    const namedScene: MusicAction = {
      ...music,
      outputs: [
        {
          kind: "speaker",
          speakerUuid: "legacy-sonos-uuid",
          label: "Kitchen",
          volume: 32,
        },
      ],
    };

    expect(resolveSpeakers(namedScene, speakers, undefined)).toEqual([
      { ...speakers[1], volume: 32 },
    ]);
  });

  it("preflights HA before any household command", async () => {
    const scene: SceneDefinition = {
      id: "scene",
      name: "Scene",
      description: null,
      icon: "✨",
      createdAt: new Date(),
      updatedAt: new Date(),
      actions: [music],
    };
    await expect(
      prepareScene(
        scene,
        {},
        {
          ha: { isConfigured: () => false, callService: vi.fn() },
          spotify: { pauseDevice: vi.fn() },
          deviceStateStore: createInMemoryDeviceStateStore(),
          discoverSpeakers: async () => speakers,
        },
      ),
    ).resolves.toMatchObject({ mediaPlayerEntityId: "media_player.living_room" });
  });

  it("stores colored lighting intent in the Hue-native xy mode", async () => {
    const firstLight = LIGHTS[0];
    if (!firstLight) throw new Error("test needs a light");
    const store = createInMemoryDeviceStateStore();
    const scene: SceneDefinition = {
      id: "scene",
      name: "Red",
      description: null,
      icon: "🔴",
      createdAt: new Date(),
      updatedAt: new Date(),
      actions: [
        {
          kind: "lighting",
          targets: [{ kind: "entity", entityId: firstLight.entityId }],
          power: true,
          brightness: 50,
          color: { kind: "rgb", red: 255, green: 0, blue: 0 },
          transitionSeconds: 2,
        },
      ],
    };

    await executeScene(
      scene,
      {},
      {
        ha: { isConfigured: () => true, callService: vi.fn() },
        spotify: { pauseDevice: vi.fn() },
        deviceStateStore: store,
        discoverSpeakers: async () => speakers,
      },
    );

    expect((await store.read(firstLight.id))?.desiredState).toMatchObject({
      color: { xy: [0.64, 0.33] },
    });
  });

  it("groups and starts the Spotify playlist through Home Assistant, never Spotify Connect", async () => {
    const firstLight = LIGHTS[0];
    if (!firstLight) throw new Error("test needs a light");
    const calls: Array<{ service: string; params: Record<string, unknown> }> = [];
    const scene: SceneDefinition = {
      id: "scene",
      name: "Scene",
      description: null,
      icon: "✨",
      createdAt: new Date(),
      updatedAt: new Date(),
      actions: [
        {
          kind: "lighting",
          targets: [{ kind: "entity", entityId: firstLight.entityId }],
          power: true,
          brightness: 50,
          color: { kind: "none" },
          transitionSeconds: 0,
        },
        music,
      ],
    };
    await executeScene(
      scene,
      {},
      {
        ha: {
          isConfigured: () => true,
          callService: async (_domain, service, params) => {
            calls.push({ service, params });
          },
        },
        // Browse credentials may still exist, but scene execution never calls Spotify's player API.
        spotify: { pauseDevice: vi.fn() },
        deviceStateStore: createInMemoryDeviceStateStore(),
        discoverSpeakers: async () => speakers,
      },
    );
    expect(calls).toContainEqual({
      service: "join",
      params: { entity_id: "media_player.living_room", group_members: ["media_player.kitchen"] },
    });
    expect(calls).toContainEqual({
      service: "play_media",
      params: {
        entity_id: "media_player.living_room",
        media_content_id: "spotify:playlist:one",
        media_content_type: "playlist",
      },
    });
    expect(calls.map((call) => call.service)).not.toContain("transfer_playback");
  });
});
