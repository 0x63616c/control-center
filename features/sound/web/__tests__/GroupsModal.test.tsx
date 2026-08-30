import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  joinAll: vi.fn(),
  join: vi.fn(),
  leave: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    sound: {
      sonosGroupJoinAll: {
        useMutation: () => ({ mutate: mocks.joinAll, isPending: false }),
      },
      sonosGroupJoin: {
        useMutation: () => ({ mutate: mocks.join }),
      },
      sonosGroupLeave: {
        useMutation: () => ({ mutate: mocks.leave }),
      },
    },
    useUtils: () => ({
      sound: { soundSystem: { invalidate: mocks.invalidate } },
    }),
  },
}));

import type { RouterOutputs } from "@/lib/trpc";
import { GroupsModal } from "../GroupsModal";

type Room = RouterOutputs["sound"]["soundSystem"]["rooms"][number];

function room(
  name: string,
  entityId: string,
  coordinatorUuid: string = entityId,
  availability: Room["availability"] = "available",
): Room {
  return {
    name,
    uuid: entityId,
    deviceIp: entityId,
    coordinatorUuid,
    memberUuids: [coordinatorUuid],
    isCoordinator: coordinatorUuid === entityId,
    volume: 30,
    muted: false,
    transportState: "STOPPED",
    sourceLabel: null,
    sourceKind: "idle",
    trackTitle: null,
    trackArtist: null,
    albumArtUri: null,
    availability,
    groupStatus: coordinatorUuid === entityId ? "Standalone" : "Following desk",
  };
}

const diagnostics = {
  kind: "ready" as const,
  controlPlane: "home-assistant" as const,
  queriedAt: "2026-08-30T16:00:00.000Z",
  message: "5 Sonos rooms reported by Home Assistant",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GroupsModal join-all workflow", () => {
  it("joins every available room not already following Desk with one tap", () => {
    const deskId = "media_player.desk";
    render(
      <GroupsModal
        diagnostics={diagnostics}
        rooms={[
          room("Desk", deskId),
          room("Living Room", "media_player.living_room", deskId),
          room("Kitchen", "media_player.kitchen"),
          room("Bathroom", "media_player.bathroom"),
          room("Bedroom", "media_player.bedroom", undefined, "unavailable"),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Join all to Desk" }));

    expect(mocks.joinAll).toHaveBeenCalledWith({
      coordinatorEntityId: deskId,
      memberEntityIds: ["media_player.kitchen", "media_player.bathroom"],
    });
  });
});
