/**
 * Stories for TransportScrubModal (www-51hf.16).
 *
 * Covers A20 acceptance: streaming playing/paused, line-in, TV (no-seek note),
 * and artwork url. All state is prop-driven; no tRPC dependencies. The
 * component is a bare page body now (hosted by TileDetailHost in the app), so
 * stories mount it inside a plain page-sized container matching the host's
 * content region.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import { TransportScrubModal } from "./TransportScrubModal";

const meta = {
  title: "Media/TransportScrubModal",
  component: TransportScrubModal,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    onPrev: fn(),
    onPlayPause: fn(),
    onNext: fn(),
    onSeek: fn(),
  },
} satisfies Meta<typeof TransportScrubModal>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Streaming , playing ───────────────────────────────────────────────────────

export const StreamingPlaying: Story = {
  args: {
    state: "playing",
    appName: "Netflix",
    mediaTitle: "Stranger Things",
    mediaArtist: "Netflix Originals",
    mediaPosition: 1250,
    mediaDuration: 3600,
    source: "streaming",
    artworkUrl: null,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText("Seek")).toBeInTheDocument();
    await expect(canvas.getByLabelText("Pause")).toBeInTheDocument();
  },
};

// ── Streaming , paused ────────────────────────────────────────────────────────

export const StreamingPaused: Story = {
  args: {
    state: "paused",
    appName: "Disney+",
    mediaTitle: "The Mandalorian",
    mediaArtist: null,
    mediaPosition: 600,
    mediaDuration: 2700,
    source: "streaming",
    artworkUrl: null,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText("Play")).toBeInTheDocument();
  },
};

// ── Line-in: no-seek note ─────────────────────────────────────────────────────

export const LineIn: Story = {
  args: {
    state: "playing",
    appName: null,
    mediaTitle: null,
    mediaArtist: null,
    mediaPosition: null,
    mediaDuration: null,
    source: "line-in",
    artworkUrl: null,
  },
  play: async ({ canvasElement }) => {
    const noSeek = canvasElement.querySelector("[data-no-seek]");
    await expect(noSeek).toBeTruthy();
    const scrub = canvasElement.querySelector("input[type='range'][aria-label='Seek']");
    await expect(scrub).toBeFalsy();
  },
};

// ── TV source: no-seek note ───────────────────────────────────────────────────

export const LiveTV: Story = {
  args: {
    state: "playing",
    appName: "TV",
    mediaTitle: "Live Sports",
    mediaArtist: null,
    mediaPosition: null,
    mediaDuration: null,
    source: "TV",
    artworkUrl: null,
  },
  play: async ({ canvasElement }) => {
    const noSeek = canvasElement.querySelector("[data-no-seek]");
    await expect(noSeek).toBeTruthy();
  },
};

// ── With artwork URL ──────────────────────────────────────────────────────────

export const WithArtwork: Story = {
  args: {
    state: "playing",
    appName: "Apple Music",
    mediaTitle: "Bohemian Rhapsody",
    mediaArtist: "Queen",
    mediaPosition: 90,
    mediaDuration: 354,
    source: "streaming",
    artworkUrl: "https://upload.wikimedia.org/wikipedia/en/4/4d/Queen_Greatest_Hits.png",
  },
  play: async ({ canvasElement }) => {
    const img = canvasElement.querySelector("img[alt*='artwork' i]");
    await expect(img).toBeTruthy();
  },
};
