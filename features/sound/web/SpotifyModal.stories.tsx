/**
 * Stories for SpotifyModal (www-51hf.25).
 * A30: Real Spotify content , recently played + made for you rows. The
 * component is a bare page body now (hosted by TileDetailHost in the app), so
 * stories mount it inside a plain page-sized container matching the host's
 * content region.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import { SpotifyModal } from "./SpotifyModal";

const recentlyPlayed = [
  {
    id: "t1",
    title: "Blinding Lights",
    artist: "The Weeknd",
    albumArtUrl: null,
    uri: "spotify:track:t1",
  },
  { id: "t2", title: "Levitating", artist: "Dua Lipa", albumArtUrl: null, uri: "spotify:track:t2" },
  { id: "t3", title: "Stay", artist: "Kid Laroi", albumArtUrl: null, uri: "spotify:track:t3" },
];

const playlists = [
  { id: "p1", title: "Daily Mix 1", description: null, imageUrl: null, uri: "spotify:playlist:p1" },
  {
    id: "p2",
    title: "Discover Weekly",
    description: null,
    imageUrl: null,
    uri: "spotify:playlist:p2",
  },
  {
    id: "p3",
    title: "Release Radar",
    description: null,
    imageUrl: null,
    uri: "spotify:playlist:p3",
  },
];

const zones = ["Living Room", "Desk", "Bedroom"];

const meta = {
  title: "Media/SpotifyModal",
  component: SpotifyModal,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    recentlyPlayed,
    playlists,
    zones,
    onPlay: fn(),
  },
} satisfies Meta<typeof SpotifyModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Rows: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Blinding Lights")).toBeInTheDocument();
    await expect(canvas.getByText("Daily Mix 1")).toBeInTheDocument();
    await expect(canvas.getByText("Living Room")).toBeInTheDocument();
  },
};
