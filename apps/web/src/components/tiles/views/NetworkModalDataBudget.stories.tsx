/**
 * Stories for NetworkModalDataBudget , Data Budget Projection modal.
 * View-driven (all data + callbacks via props). No play functions needed for
 * the POC; kept lightweight.
 *
 * Grouped under "Modals/Network" alongside any future Network detail modals.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "../__stories__/factory";
import type { TrafficBucket } from "./NetworkModalDataBudget";
import { NetworkModalDataBudget } from "./NetworkModalDataBudget";

// ─── fixtures ─────────────────────────────────────────────────────────────────

/**
 * Synthesise a realistic 24-bucket window: mostly low background traffic
 * with a mid-window spike (buckets 10–14) representing an active download.
 * All values are raw bytes as the UniFi API delivers them.
 */
function makeBuckets(): TrafficBucket[] {
  const buckets: TrafficBucket[] = [];
  for (let i = 0; i < 24; i++) {
    const isSpikeWindow = i >= 10 && i <= 14;
    buckets.push({
      down: isSpikeWindow ? 18_000_000 + i * 500_000 : 800_000 + i * 20_000,
      up: isSpikeWindow ? 2_500_000 : 220_000 + i * 5_000,
    });
  }
  return buckets;
}

/** Low-traffic window: background usage only, well inside a 200 GB cap. */
function makeQuietBuckets(): TrafficBucket[] {
  return Array.from({ length: 24 }, (_, i) => ({
    down: 120_000 + i * 3_000,
    up: 40_000 + i * 1_000,
  }));
}

const activeBuckets = makeBuckets();
const quietBuckets = makeQuietBuckets();

// Primary fixture: heavy usage projected to exceed a 100 GB monthly cap.
const heavyUsageFixture = {
  connectionStatus: "Online" as const,
  ssid: "Home-5GHz",
  down: "18.4",
  up: "4.2",
  traffic: activeBuckets,
  monthlyCapGb: 100,
};

// Secondary fixture: quiet connection well within budget.
const quietUsageFixture = {
  connectionStatus: "Online" as const,
  ssid: "Home-5GHz",
  down: "1.2",
  up: "0.4",
  traffic: quietBuckets,
  monthlyCapGb: 200,
};

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Network/Data Budget",
  component: NetworkModalDataBudget,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    ...heavyUsageFixture,
  },
} satisfies Meta<typeof NetworkModalDataBudget>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Data Budget Projection , primary (heavy, over budget) ────────────────────

export const DataBudgetProjection: Story = {
  name: "Data Budget Projection",
};

// ─── Light traffic , well within budget ───────────────────────────────────────

export const LightTraffic: Story = {
  name: "Light traffic , within budget",
  args: quietUsageFixture,
};

// ─── Offline ──────────────────────────────────────────────────────────────────

export const Offline: Story = {
  name: "Offline connection",
  args: {
    ...heavyUsageFixture,
    connectionStatus: "Offline",
    down: "0.0",
    up: "0.0",
    traffic: Array.from({ length: 24 }, () => ({ down: 0, up: 0 })),
  },
};
