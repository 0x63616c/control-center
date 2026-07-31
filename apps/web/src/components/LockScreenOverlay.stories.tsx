import type { Meta, StoryObj } from "@storybook/react-vite";
import { LockScreenOverlay } from "./LockScreenOverlay";

const meta = {
  title: "Panel/Lock screen overlay",
  component: LockScreenOverlay,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: { active: true, blurPercent: 10, onRequestUnlock: () => {} },
} satisfies Meta<typeof LockScreenOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const NoBlur: Story = { args: { blurPercent: 0 } };
export const MaximumBlur: Story = { args: { blurPercent: 100 } };
