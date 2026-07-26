/**
 * Stories for NetworkModalTrafficTimeline , the traffic drill-down page body.
 * View-driven (all data + callbacks via props). The component is a bare page
 * body now (hosted by TileDetailHost in the app), so stories mount it inside a
 * plain page-sized container matching the host's content region.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "../__stories__/factory";
import type { TrafficBucket } from "./NetworkModalTrafficTimeline";
import { NetworkModalTrafficTimeline } from "./NetworkModalTrafficTimeline";

// ─── fixtures ─────────────────────────────────────────────────────────────────

/** 24 buckets simulating a typical afternoon pattern: moderate baseline with a
 *  busy spike around bucket 14-16 (roughly 70-90 min into the window). Values
 *  are raw bytes , realistic for home broadband (10-100 MB/s range). */
const typicalTraffic: TrafficBucket[] = [
  { down: 1_200_000, up: 320_000 },
  { down: 980_000, up: 210_000 },
  { down: 1_450_000, up: 380_000 },
  { down: 2_100_000, up: 450_000 },
  { down: 1_800_000, up: 400_000 },
  { down: 2_500_000, up: 520_000 },
  { down: 3_200_000, up: 680_000 },
  { down: 4_100_000, up: 890_000 },
  { down: 3_800_000, up: 820_000 },
  { down: 5_200_000, up: 1_100_000 },
  { down: 6_800_000, up: 1_400_000 },
  { down: 7_500_000, up: 1_600_000 },
  { down: 8_200_000, up: 1_800_000 },
  { down: 12_400_000, up: 2_200_000 },
  { down: 18_700_000, up: 3_100_000 }, // peak
  { down: 15_300_000, up: 2_800_000 },
  { down: 9_600_000, up: 1_900_000 },
  { down: 7_200_000, up: 1_500_000 },
  { down: 5_800_000, up: 1_200_000 },
  { down: 4_400_000, up: 980_000 },
  { down: 3_100_000, up: 720_000 },
  { down: 2_600_000, up: 580_000 },
  { down: 1_900_000, up: 420_000 },
  { down: 1_400_000, up: 310_000 },
];

/** All-zero buckets represent a network gap or very early morning with no
 *  measurable traffic. The chart should render a flat axis with no bars. */
const zeroTraffic: TrafficBucket[] = Array.from({ length: 24 }, () => ({
  down: 0,
  up: 0,
}));

/** Stable reference time for stories (2025-06-15 14:30 UTC) so snapshot tests
 *  produce deterministic x-axis labels regardless of when they run. */
const STORY_NOW = new Date("2025-06-15T14:30:00Z").getTime();

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Network/Traffic Timeline",
  component: NetworkModalTrafficTimeline,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    traffic: typicalTraffic,
    down: "18.4",
    up: "4.2",
    ssid: "Home_5G",
    ping: 11,
    status: "Online",
    newestBucketAt: STORY_NOW,
  },
} satisfies Meta<typeof NetworkModalTrafficTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Traffic Timeline (primary) ───────────────────────────────────────────────

export const TrafficTimeline: Story = {
  name: "Traffic Timeline",
};

// ─── Offline / zero traffic ───────────────────────────────────────────────────

export const OfflineNoTraffic: Story = {
  name: "Offline , no traffic",
  args: {
    traffic: zeroTraffic,
    down: "0.0",
    up: "0.0",
    ping: 999,
    status: "Offline",
  },
};
