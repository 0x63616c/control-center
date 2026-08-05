import { createInMemoryDeviceStateStore, LIGHTS } from "@www/core";
import { describe, expect, it, vi } from "vitest";
import { executeScene, resolvePlaylist, resolveSpeakers } from "./executor";
import type { MusicAction, SceneDefinition, SceneSpeaker } from "./model";

const music: MusicAction = {
  kind: "music",
  source: {
    kind: "spotify",
    playlists: [
      { name: "One", uri: "spotify:playlist:one" },
      { name: "Two", uri: "spotify:playlist:two" },
    ],
    selection: "prompt",
    shuffleTracks: true,
  },
  outputs: [{ kind: "all", volume: 25 }],
};

const speakers: SceneSpeaker[] = [
  { uuid: "RINCON_LIVING", name: "Living Room", deviceIp: "192.0.2.1", volume: 12 },
  { uuid: "RINCON_KITCHEN", name: "Kitchen", deviceIp: "192.0.2.2", volume: 15 },
];

describe("scene launch resolution", () => {
  it("requires a choice for prompt mode with multiple playlists", () => {
    expect(() => resolvePlaylist(music, undefined)).toThrow("Choose a playlist");
    expect(resolvePlaylist(music, "spotify:playlist:two").name).toBe("Two");
  });

  it("resolves random playlist selection deterministically", () => {
    expect(
      resolvePlaylist(
        { ...music, source: { ...music.source, selection: "random" } },
        undefined,
        () => 0.99,
      ).name,
    ).toBe("Two");
  });

  it("keeps launch speaker overrides temporary and rejects missing speakers", () => {
    const resolved = resolveSpeakers(music, speakers, [
      { speakerUuid: "RINCON_LIVING", enabled: true, volume: 42 },
      { speakerUuid: "RINCON_KITCHEN", enabled: false, volume: 10 },
    ]);
    expect(resolved).toEqual([{ ...speakers[0], volume: 42 }]);
    expect(music.outputs).toEqual([{ kind: "all", volume: 25 }]);
    expect(() =>
      resolveSpeakers(music, speakers, [
        { speakerUuid: "RINCON_MISSING", enabled: true, volume: 20 },
      ]),
    ).toThrow("unavailable");
  });
});

describe("executeScene", () => {
  it("writes lighting intent, groups Sonos, sets volumes, and starts the Spotify context", async () => {
    const firstLight = LIGHTS[0];
    if (!firstLight) throw new Error("test needs one configured light");
    const store = createInMemoryDeviceStateStore();
    const calls: string[] = [];
    const spotify = {
      getDevices: vi.fn().mockResolvedValue([
        {
          id: "spotify_living",
          name: "Living Room",
          type: "Speaker",
          isActive: false,
          isRestricted: false,
        },
      ]),
      transferPlayback: vi.fn(async (id: string) => {
        calls.push(`transfer:${id}`);
      }),
      setShuffle: vi.fn(async (enabled: boolean, id: string) => {
        calls.push(`shuffle:${enabled}:${id}`);
      }),
      playContext: vi.fn(async (uri: string, id: string) => {
        calls.push(`play:${uri}:${id}`);
      }),
      pauseDevice: vi.fn(),
    };
    const scene: SceneDefinition = {
      id: "scene_test",
      name: "Test",
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
          color: { kind: "rgb", red: 255, green: 0, blue: 0 },
          transitionSeconds: 3,
        },
        { ...music, source: { ...music.source, selection: "fixed" } },
      ],
    };

    const result = await executeScene(
      scene,
      {},
      {
        ha: { isConfigured: () => true },
        spotify,
        deviceStateStore: store,
        discoverSpeakers: async () => speakers,
        createSonosClient: (deviceIp) => ({
          becomeCoordinatorOfStandaloneGroup: async () => {
            calls.push(`standalone:${deviceIp}`);
          },
          setAVTransportURI: async (uri) => {
            calls.push(`join:${deviceIp}:${uri}`);
          },
          setVolume: async (volume) => {
            calls.push(`volume:${deviceIp}:${volume}`);
          },
        }),
      },
    );

    expect(result.playlist?.name).toBe("One");
    expect(result.speakers.map((speaker) => speaker.volume)).toEqual([25, 25]);
    expect(calls).toContain("join:192.0.2.2:x-rincon:RINCON_LIVING");
    expect(calls).toContain("play:spotify:playlist:one:spotify_living");
    const row = (await store.list({ entityIds: [firstLight.entityId] }))[0];
    expect(row?.desiredState).toEqual({
      on: true,
      brightness: 128,
      color: { rgb: [255, 0, 0] },
      transitionSeconds: 3,
    });
  });
});
