import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { JoinAllAction } from "./GroupsModal";

const meta = {
  title: "Media/Sound System/Join All Action",
  component: JoinAllAction,
  tags: ["autodocs"],
  parameters: { boardWrapper: false },
  decorators: [
    (Story) => (
      <div style={{ width: 960, padding: 24, background: "var(--bg)" }}>
        <Story />
      </div>
    ),
  ],
  args: {
    state: { kind: "ready", roomCount: 3 },
    status: null,
    onJoin: fn(),
  },
} satisfies Meta<typeof JoinAllAction>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The frequent whole-home workflow is the Sound System page's primary top-right action. */
export const ReadyToGroup: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Join all to Desk" })).toBeEnabled();
  },
};

/** The working state keeps the scope visible and prevents a duplicate command. */
export const Joining: Story = {
  args: { state: { kind: "pending", roomCount: 3 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Joining 3 rooms…" })).toBeDisabled();
  },
};

/** Once every available room follows Desk, the action explains why it is disabled. */
export const AlreadyGrouped: Story = {
  args: { state: { kind: "complete" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "All grouped with Desk" })).toBeDisabled();
  },
};

/** A missing or offline Desk room produces an explanatory disabled state. */
export const DeskUnavailable: Story = {
  args: { state: { kind: "unavailable" } },
};
