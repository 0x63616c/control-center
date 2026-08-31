import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ConfettiCelebrationView } from "./ConfettiCelebration";

const meta = {
  title: "Components/Overlays/Confetti Celebration",
  component: ConfettiCelebrationView,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ minHeight: "100vh", background: "var(--nest)", position: "relative" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ConfettiCelebrationView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SuccessfulCleaning: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId("confetti-celebration")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  },
};
