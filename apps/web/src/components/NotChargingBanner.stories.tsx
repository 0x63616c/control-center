import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { NotChargingBannerView } from "./NotChargingBanner";

// Board-like container so the absolute positioning renders correctly (same
// stage as the other banner stories). The live NotChargingBanner container
// renders nothing off-native (no readable battery), so the story drives the
// presentational view directly.
function BoardStage({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "relative",
        width: 1366,
        height: 260,
        background: "#0c0e11",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

const meta = {
  title: "Components/Banners/Not Charging",
  component: NotChargingBannerView,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <BoardStage>
        <Story />
      </BoardStage>
    ),
  ],
} satisfies Meta<typeof NotChargingBannerView>;

export default meta;
type Story = StoryObj<typeof meta>;

// The panel reports it is not charging , a red, prominent fault banner.
export const NotCharging: Story = {
  args: { deviceName: "Kitchen Panel" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toBeInTheDocument();
    await expect(canvas.getByText(/Kitchen Panel is not charging/i)).toBeInTheDocument();
    await expect(canvas.getByText(/Check the dock cable and power adapter/i)).toBeInTheDocument();
  },
};
