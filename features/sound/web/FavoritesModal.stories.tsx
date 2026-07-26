/**
 * Stories for FavoritesModal (www-51hf.24).
 * A29: Real cover grid + zone target picker. The component is a bare page body
 * now (hosted by TileDetailHost in the app), so stories mount it inside a
 * plain page-sized container matching the host's content region.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import { FavoritesModal } from "./FavoritesModal";

const favorites = [
  { title: "Chill Mix", uri: "x-sonosapi:chill", albumArtUri: null },
  { title: "Morning Vibes", uri: "x-sonosapi:morning", albumArtUri: null },
  { title: "Late Night Jazz", uri: "x-sonosapi:jazz", albumArtUri: null },
  { title: "Workout Beats", uri: "x-sonosapi:workout", albumArtUri: null },
];

const zones = ["Living Room", "Desk", "Bedroom", "Kitchen"];

const meta = {
  title: "Media/FavoritesModal",
  component: FavoritesModal,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    favorites,
    zones,
    onPlay: fn(),
  },
} satisfies Meta<typeof FavoritesModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Grid: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Chill Mix")).toBeInTheDocument();
    await expect(canvas.getByText("Living Room")).toBeInTheDocument();
  },
};
