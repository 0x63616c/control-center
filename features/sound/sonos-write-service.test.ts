import { describe, expect, it, vi } from "vitest";
import { playMediaOnRoom, sonosGroupJoin, sonosSetVolume } from "./sonos-write-service";

describe("HA sound writes", () => {
  it("sends volume, grouping, and Spotify media to Home Assistant", async () => {
    const callService = vi.fn().mockResolvedValue(undefined);
    const ha = { callService };
    await sonosSetVolume({ deviceIp: "media_player.kitchen", volume: 24 }, ha);
    await sonosGroupJoin(
      { memberIp: "media_player.kitchen", coordinatorUuid: "media_player.desk" },
      ha,
    );
    await playMediaOnRoom({ entityId: "media_player.desk", uri: "spotify:playlist:abc" }, ha);
    expect(callService).toHaveBeenNthCalledWith(1, "media_player", "volume_set", {
      entity_id: "media_player.kitchen",
      volume_level: 0.24,
    });
    expect(callService).toHaveBeenNthCalledWith(2, "media_player", "join", {
      entity_id: "media_player.desk",
      group_members: ["media_player.kitchen"],
    });
    expect(callService).toHaveBeenNthCalledWith(3, "media_player", "play_media", {
      entity_id: "media_player.desk",
      media_content_id: "spotify:playlist:abc",
      media_content_type: "playlist",
    });
  });
});
