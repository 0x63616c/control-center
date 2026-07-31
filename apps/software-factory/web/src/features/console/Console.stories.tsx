import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ConsoleResponse } from "@/api/generated";
import { Console } from "@/features/console/Console";

const snapshot = (overrides: Partial<ConsoleResponse> = {}): ConsoleResponse => ({
  factory: {
    paused: false,
    pauseReason: "",
    maxInFlight: 3,
    configError: "",
    breakerOpen: false,
    breakerReason: "",
    breakerOpenUntil: "0001-01-01T00:00:00Z",
  },
  dispatcher: {
    inFlight: [],
    candidates: [],
    freeSlots: 3,
    writtenAt: "2026-07-31T12:00:00Z",
    ageSeconds: 12,
    stale: false,
  },
  tickets: [],
  ...overrides,
});
const ticket = (id: number, title: string, state: string) => ({
  id,
  title,
  state,
  ready: false,
  createdAt: "2026-07-31T10:00:00Z",
  updatedAt: "2026-07-31T11:00:00Z",
});
const meta = { component: Console, tags: ["autodocs"] } satisfies Meta<typeof Console>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NothingInFlight: Story = { args: { state: { kind: "ready", snapshot: snapshot() } } };
export const SeveralInFlight: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: snapshot({
        dispatcher: {
          inFlight: [
            { issueNumber: 551, runID: "run-a", startedAt: "2026-07-31T11:00:00Z" },
            { issueNumber: 552, runID: "run-b", startedAt: "2026-07-31T11:30:00Z" },
          ],
          candidates: [553, 554],
          freeSlots: 1,
          writtenAt: "2026-07-31T12:00:00Z",
          ageSeconds: 12,
          stale: false,
        },
      }),
    },
  },
};
export const BlockedByOpenTicket: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: snapshot({
        tickets: [
          { ...ticket(1, "Upstream", "working"), blockers: [] },
          { ...ticket(2, "Downstream", "open"), blockers: [ticket(1, "Upstream", "working")] },
        ],
      }),
    },
  },
};
export const BlockedByFailedTicket: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: snapshot({
        tickets: [
          { ...ticket(1, "Failed upstream", "failed"), blockers: [] },
          {
            ...ticket(2, "Blocked downstream", "open"),
            blockers: [ticket(1, "Failed upstream", "failed")],
          },
        ],
      }),
    },
  },
};
export const Paused: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: snapshot({
        factory: {
          paused: true,
          pauseReason: "Waiting for an operator",
          maxInFlight: 3,
          configError: "",
          breakerOpen: false,
          breakerReason: "",
          breakerOpenUntil: "0001-01-01T00:00:00Z",
        },
      }),
    },
  },
};
export const BreakerTripped: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: snapshot({
        factory: {
          paused: false,
          pauseReason: "",
          maxInFlight: 3,
          configError: "",
          breakerOpen: true,
          breakerReason: "Rate limit reached",
          breakerOpenUntil: "2026-07-31T12:15:00Z",
        },
      }),
    },
  },
};
export const StaleDispatcherState: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: snapshot({
        dispatcher: {
          inFlight: [],
          candidates: [555],
          freeSlots: 2,
          writtenAt: "2026-07-31T10:00:00Z",
          ageSeconds: 7200,
          stale: true,
        },
      }),
    },
  },
};
export const FailedRefetch: Story = {
  args: { state: { kind: "refetch-error", message: "Network Error", snapshot: snapshot() } },
};
