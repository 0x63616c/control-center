import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  joinAll: vi.fn(),
  join: vi.fn(),
  leave: vi.fn(),
  invalidate: vi.fn(),
  joinAllOptions: null as null | {
    onMutate?: () => void;
    onSuccess?: () => void;
    onError?: (error: unknown) => void;
  },
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    sound: {
      sonosGroupJoinAll: {
        useMutation: (options: NonNullable<typeof mocks.joinAllOptions>) => {
          mocks.joinAllOptions = options;
          return {
            mutate: (input: unknown) => {
              options.onMutate?.();
              mocks.joinAll(input);
            },
            isPending: false,
          };
        },
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

  it("disables the action when Desk is unavailable", () => {
    render(
      <GroupsModal
        diagnostics={diagnostics}
        rooms={[
          room("Desk", "media_player.desk", undefined, "unavailable"),
          room("Kitchen", "media_player.kitchen"),
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "Desk unavailable" })).toBeDisabled();
  });

  it("disables the action when every available room already follows Desk", () => {
    const deskId = "media_player.desk";
    render(
      <GroupsModal
        diagnostics={diagnostics}
        rooms={[
          room("Desk", deskId),
          room("Kitchen", "media_player.kitchen", deskId),
          room("Bathroom", "media_player.bathroom", deskId),
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "All grouped with Desk" })).toBeDisabled();
  });

  it("uses Desk's current group when Desk is following another coordinator", () => {
    const livingRoomId = "media_player.living_room";
    render(
      <GroupsModal
        diagnostics={diagnostics}
        rooms={[
          room("Living Room", livingRoomId),
          room("Desk", "media_player.desk", livingRoomId),
          room("Bedroom", "media_player.bedroom", livingRoomId),
          room("Kitchen", "media_player.kitchen"),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Join all to Desk" }));

    expect(mocks.joinAll).toHaveBeenCalledWith({
      coordinatorEntityId: livingRoomId,
      memberEntityIds: ["media_player.kitchen"],
    });
  });

  it("announces success and refreshes the live group snapshot", () => {
    render(
      <GroupsModal
        diagnostics={diagnostics}
        rooms={[room("Desk", "media_player.desk"), room("Kitchen", "media_player.kitchen")]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Join all to Desk" }));
    act(() => mocks.joinAllOptions?.onSuccess?.());

    expect(screen.getByRole("status")).toHaveTextContent(
      "Join command sent. Refreshing group status…",
    );
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed join command", () => {
    render(
      <GroupsModal
        diagnostics={diagnostics}
        rooms={[room("Desk", "media_player.desk"), room("Kitchen", "media_player.kitchen")]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Join all to Desk" }));
    act(() => mocks.joinAllOptions?.onError?.(new Error("Sonos did not accept the group")));

    expect(screen.getByRole("alert")).toHaveTextContent("Sonos did not accept the group");
  });
});
