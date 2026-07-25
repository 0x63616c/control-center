/**
 * Stories for AllAppsModal (www-51hf.22).
 * A27: Searchable full-color grid of Apple TV apps. The component is a bare
 * page body now (hosted by TileDetailHost in the app), so stories mount it
 * inside a plain page-sized container matching the host's content region.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import { AllAppsModal } from "./AllAppsModal";

const apps = [
  "Netflix",
  "Disney+",
  "Hulu",
  "Apple TV+",
  "YouTube",
  "Spotify",
  "Prime Video",
  "HBO Max",
  "Peacock",
  "Paramount+",
];

const meta = {
  title: "Media/AllAppsModal",
  component: AllAppsModal,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region,
  // sized to the real fixed 1366x1024 panel (#66) so the story demonstrates
  // true fill-to-bottom behavior rather than an arbitrary browser 100vh.
  decorators: [pageHostDecorator(1024)],
  args: {
    apps,
    currentApp: "Netflix",
    onLaunchApp: fn(),
  },
} satisfies Meta<typeof AllAppsModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Grid: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText("Search apps")).toBeInTheDocument();
    await expect(canvas.getByLabelText("Launch Netflix")).toBeInTheDocument();
  },
};

/** The full live prod source_list (www-rii3) , every app must show a brand mark. */
export const FullProdList: Story = {
  args: {
    apps: [
      "AMC+",
      "App Store",
      "Arcade",
      "BBC iPlayer",
      "CNN",
      "Computers",
      "Disney+",
      "FaceTime",
      "Fitness",
      "HBO Max",
      "Hulu",
      "Music",
      "Netflix",
      "Paramount+",
      "Peacock",
      "Photos",
      "Podcasts",
      "Prime Video",
      "Search",
      "Settings",
      "Sling",
      "Spotify",
      "TV",
      "Twitch",
      "VLC",
      "Watch TruBlu",
      "YouTube",
    ],
    currentApp: "YouTube",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText("Launch YouTube")).toBeInTheDocument();
  },
};

/**
 * A search narrowed to 1-2 matches (#66): the grid must still fill the host
 * region with placeholder cells rather than leaving dead space , the exact
 * scenario the fixed-viewport bug left uncovered.
 */
export const FilteredFewMatches: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText("Search apps"), "Netflix");
    await expect(canvas.getByLabelText("Launch Netflix")).toBeInTheDocument();
    await expect(canvas.queryByLabelText("Launch Disney+")).not.toBeInTheDocument();
  },
};
