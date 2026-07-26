/**
 * Stories for NetworkModalUsageSignature , the Usage Signature detail modal.
 * View-driven (all data + callbacks via props).
 *
 * Grouped under "Modals/Network" so it appears alongside other detail modals in
 * Storybook's sidebar, not under "Tiles/".
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "../__stories__/factory";
import type { TrafficBucket } from "./NetworkModalUsageSignature";
import { NetworkModalUsageSignature } from "./NetworkModalUsageSignature";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// A representative 24-bucket window: varied activity across all four classes.
// Buckets 0-4: idle overnight, 5-9: streaming (heavy download), 10-13: video
// call (symmetric), 14-17: cloud backup (upload-heavy), 18-23: streaming again.
const mixedTraffic: TrafficBucket[] = [
  // idle (0-4)
  { down: 10_000, up: 5_000 },
  { down: 8_000, up: 4_000 },
  { down: 12_000, up: 6_000 },
  { down: 9_500, up: 3_200 },
  { down: 11_000, up: 4_800 },
  // streaming (5-9) , download-heavy
  { down: 4_200_000, up: 80_000 },
  { down: 5_100_000, up: 95_000 },
  { down: 4_800_000, up: 72_000 },
  { down: 5_600_000, up: 88_000 },
  { down: 4_950_000, up: 91_000 },
  // video call (10-13) , symmetric
  { down: 1_200_000, up: 1_050_000 },
  { down: 1_350_000, up: 1_180_000 },
  { down: 1_280_000, up: 1_220_000 },
  { down: 1_400_000, up: 1_310_000 },
  // backup (14-17) , upload-heavy
  { down: 200_000, up: 3_400_000 },
  { down: 180_000, up: 3_250_000 },
  { down: 190_000, up: 3_600_000 },
  { down: 170_000, up: 3_100_000 },
  // streaming again (18-23)
  { down: 5_800_000, up: 110_000 },
  { down: 6_200_000, up: 125_000 },
  { down: 5_950_000, up: 98_000 },
  { down: 6_100_000, up: 115_000 },
  { down: 5_750_000, up: 105_000 },
  { down: 5_400_000, up: 92_000 },
];

// A quiet window: mostly idle with a short burst of light browsing.
// Exercises the "no active windows" path for the upload-heavy callout.
const quietTraffic: TrafficBucket[] = Array.from({ length: 24 }, (_, i) => {
  if (i >= 10 && i <= 13) {
    // light browsing , small download bursts, still qualifies as streaming
    return { down: 350_000, up: 40_000 };
  }
  // true idle
  return { down: 15_000, up: 8_000 };
});

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Network/Usage Signature",
  component: NetworkModalUsageSignature,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    ssid: "Home-5G",
    down: "18.4 GB",
    up: "9.2 GB",
    traffic: mixedTraffic,
  },
} satisfies Meta<typeof NetworkModalUsageSignature>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Usage Signature , mixed activity (primary) ────────────────────────────────

export const UsageSignature: Story = {
  name: "Usage Signature , mixed activity",
};

// ─── Quiet window , mostly idle ───────────────────────────────────────────────

export const QuietWindow: Story = {
  name: "Quiet window , mostly idle",
  args: {
    ssid: "Home-5G",
    down: "1.1 GB",
    up: "0.3 GB",
    traffic: quietTraffic,
  },
};
