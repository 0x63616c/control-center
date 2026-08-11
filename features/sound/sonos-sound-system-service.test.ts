import { describe, expect, it } from "vitest";
import { getSoundSystem, roomFromHaEntity } from "./sonos-sound-system-service";

const bedroom = {
  entity_id: "media_player.bedroom",
  state: "playing",
  last_updated: "2026-08-11T00:00:00Z",
  attributes: {
    friendly_name: "Bedroom",
    group_members: ["media_player.desk", "media_player.bedroom"],
    volume_level: 0.33,
    is_volume_muted: false,
    source: "Line-in",
    media_title: "Desk audio",
  },
};

describe("Home Assistant sound-system snapshot", () => {
  it("uses HA entity identity and distinguishes idle from unavailable", async () => {
    const snapshot = await getSoundSystem({
      isConfigured: () => true,
      getEntities: async () => [
        bedroom,
        { ...bedroom, entity_id: "media_player.tv", attributes: {} },
      ],
    });
    expect(snapshot.rooms).toHaveLength(1);
    expect(snapshot.rooms[0]).toMatchObject({
      uuid: "media_player.bedroom",
      coordinatorUuid: "media_player.desk",
      volume: 33,
      sourceKind: "line-in",
      groupStatus: "Following desk",
      availability: "available",
    });
    expect(snapshot.diagnostics.controlPlane).toBe("home-assistant");
  });

  it("does not call a stopped-but-online player off", () => {
    const room = roomFromHaEntity({
      ...bedroom,
      state: "idle",
      attributes: { ...bedroom.attributes, group_members: ["media_player.bedroom"] },
    });
    expect(room).toMatchObject({
      transportState: "STOPPED",
      availability: "available",
      groupStatus: "Standalone",
    });
  });
});
