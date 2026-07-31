import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ConsoleResponse } from "@/api/generated";
import { Console } from "@/features/console/Console";

const snapshot = (overrides: Partial<ConsoleResponse> = {}): ConsoleResponse => ({
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

export const NoTickets: Story = { args: { state: { kind: "ready", snapshot: snapshot() } } };
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
export const FailedRefetch: Story = {
  args: { state: { kind: "refetch-error", message: "Network Error", snapshot: snapshot() } },
};
