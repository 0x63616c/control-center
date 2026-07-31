import type { Meta, StoryObj } from "@storybook/react-vite";
import { BuildStatus } from "@/features/build-status/BuildStatus";

const meta = {
  title: "Build/BuildStatus",
  component: BuildStatus,
  tags: ["autodocs"],
} satisfies Meta<typeof BuildStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  args: { state: { kind: "loading" } },
};

export const Ready: Story = {
  args: { state: { kind: "ready", version: "abc1234" } },
};

export const ErrorState: Story = {
  args: { state: { kind: "error", message: "Network Error" } },
};
