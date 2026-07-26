/**
 * Stories for NetworkModalConnectionHealth.
 * View-driven (all data + callbacks via props). Grouped under "Modals/Network"
 * as an overlay surface , falls through to the plain dark wrapper in Storybook.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "../__stories__/factory";
import { NetworkModalConnectionHealth } from "./NetworkModalConnectionHealth";

// ─── fixtures ─────────────────────────────────────────────────────────────────

/** Generate a realistic set of 24 five-minute traffic buckets (raw bytes).
 *  Peak at bucket 18 simulates a burst ~90 minutes ago. Newest bucket = index 23. */
function makeBuckets(baseDn: number, baseUp: number): Array<{ down: number; up: number }> {
  return Array.from({ length: 24 }, (_, i) => {
    const spike = i === 18 ? 3.2 : 1;
    return {
      down: Math.round(baseDn * spike * (0.85 + Math.random() * 0.3) * 125_000 * 300),
      up: Math.round(baseUp * spike * (0.85 + Math.random() * 0.3) * 125_000 * 300),
    };
  });
}

// Healthy home WAN , fast fiber, low ping
const healthyBuckets = makeBuckets(180, 45);

const healthyData = {
  isOnline: true as const,
  ping: 14,
  ssid: "Home_5G",
  down: "18.4",
  up: "4.2",
  traffic: healthyBuckets,
};

// Degraded WAN , high latency, slow throughput, still technically online
const degradedBuckets = makeBuckets(4, 1);

const degradedData = {
  isOnline: true as const,
  ping: 118,
  ssid: "Home_5G",
  down: "0.8",
  up: "0.2",
  traffic: degradedBuckets,
};

// Fully offline , zero ping, zero traffic
const offlineData = {
  isOnline: false as const,
  ping: 0,
  ssid: "Home_5G",
  down: "0.0",
  up: "0.0",
  traffic: Array.from({ length: 24 }, () => ({ down: 0, up: 0 })),
};

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Network/Connection Health",
  component: NetworkModalConnectionHealth,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    ...healthyData,
  },
} satisfies Meta<typeof NetworkModalConnectionHealth>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Connection Health , healthy (primary state) ───────────────────────────────

export const ConnectionHealth: Story = {
  name: "Connection Health , healthy",
  args: { ...healthyData },
};

// ─── Connection Health , degraded (amber ring, high latency) ──────────────────

export const ConnectionHealthDegraded: Story = {
  name: "Connection Health , degraded",
  args: { ...degradedData },
};

// ─── Connection Health , offline ──────────────────────────────────────────────

export const ConnectionHealthOffline: Story = {
  name: "Connection Health , offline",
  args: { ...offlineData },
};
