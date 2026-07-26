/**
 * Stories for TeslaModalChargeSession , the charge session detail page body.
 * View-driven (all data + callbacks via props). Grouped under "Modals/Tesla" ,
 * the component is a bare page body now (hosted by TileDetailHost in the app),
 * so stories mount it inside a plain page-sized container matching the host's
 * content region.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { modalDocsParameters, pageHostDecorator } from "../__stories__/factory";
import { TeslaModalChargeSession } from "./TeslaModalChargeSession";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// Simulated in-session samples: 12 points over ~20 minutes of charging from 54%.
// Timestamps are relative offsets so the sparkline has a visible rising slope.
const now = Date.now();
const chargingSamples = [
  { ts: now - 19 * 60_000, pct: 54, rate: 23 },
  { ts: now - 17 * 60_000, pct: 55, rate: 24 },
  { ts: now - 15 * 60_000, pct: 56, rate: 24 },
  { ts: now - 13 * 60_000, pct: 57, rate: 25 },
  { ts: now - 11 * 60_000, pct: 58, rate: 25 },
  { ts: now - 9 * 60_000, pct: 59, rate: 24 },
  { ts: now - 7 * 60_000, pct: 60, rate: 26 },
  { ts: now - 5 * 60_000, pct: 61, rate: 25 },
  { ts: now - 3 * 60_000, pct: 62, rate: 25 },
  { ts: now - 1 * 60_000, pct: 63, rate: 24 },
  { ts: now - 30_000, pct: 63, rate: 25 },
  { ts: now, pct: 64, rate: 25 },
];

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Tesla/Charge Session",
  component: TeslaModalChargeSession,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    pct: 64,
    range: 192,
    rate: 25,
    chargingState: "charging" as const,
    samples: chargingSamples,
    targetPct: 80,
    onStartCharge: fn(),
    onStopCharge: fn(),
    chargePending: false,
  },
} satisfies Meta<typeof TeslaModalChargeSession>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Charge Session ───────────────────────────────────────────────────────────

export const ChargeSession: Story = {
  name: "Charge Session , charging, 12 samples",
};

// ─── Disconnected , no curve, honest empty state ──────────────────────────────

// When the car is disconnected: rate=0, samples=[], ETA and rate show "--".
// The sparkline shows the "Accumulating data..." empty state because there are
// no samples yet. The Start Charge button is present and enabled.
export const Disconnected: Story = {
  name: "Disconnected , no curve, start charge available",
  args: {
    pct: 78,
    range: 234,
    rate: 0,
    chargingState: "disconnected" as const,
    samples: [],
    targetPct: 80,
  },
};

// ─── Charge complete ──────────────────────────────────────────────────────────

// Charge has reached the target. Rate=0, ETA="--", pct near target.
// Ring is full green. Stop Charge is still shown (user may want to override).
export const Complete: Story = {
  name: "Complete , charge finished",
  args: {
    pct: 80,
    range: 240,
    rate: 0,
    chargingState: "complete" as const,
    samples: chargingSamples,
    targetPct: 80,
  },
};

// ─── Stopped , amber state ────────────────────────────────────────────────────

// Charging was stopped (not disconnected , cable still connected but paused).
// Ring and button show amber tones.
export const Stopped: Story = {
  name: "Stopped , cable connected, not charging",
  args: {
    pct: 60,
    range: 180,
    rate: 0,
    chargingState: "stopped" as const,
    samples: chargingSamples.slice(0, 6),
    targetPct: 80,
  },
};
