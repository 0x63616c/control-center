/**
 * Stories for ClockStopwatchView , the Stopwatch variant of the Clock detail
 * page. View-driven: `state` + `nowMs` + callbacks via props, so every story
 * pins a fixed instant for deterministic snapshots , the app's
 * `StopwatchVariant` wrapper drives `nowMs` via requestAnimationFrame.
 * Grouped under "Modals/Clock" beside the kept clock pages.
 *
 * Fixtures ONLY here (repo rule): the runtime wiring reads the real store.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import type { StopwatchState } from "@/lib/time-suite/types";
import { ClockStopwatchView } from "./ClockStopwatchView";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// Fixed "now" , all elapsed math derives from offsets against this instant.
const FIXED_NOW_MS = new Date("2026-05-30T21:37:00.000Z").getTime();

// Untouched stopwatch , 00:00.00, Lap disabled, Start ready.
const zeroState: StopwatchState = {
  running: false,
  startedAtMs: null,
  accumulatedMs: 0,
  lapStartElapsedMs: 0,
  laps: [],
};

// Mid-run with three completed laps (newest first): lap 2 is fastest (accent),
// lap 3 is slowest (muted), lap 4 is in progress at ~11.66 s.
const runningLaps = [
  { id: "lap_3", ms: 33_710 },
  { id: "lap_2", ms: 28_970 },
  { id: "lap_1", ms: 31_120 },
];
const runningElapsedMs = 105_460; // 01:45.46
const runningState: StopwatchState = {
  running: true,
  startedAtMs: FIXED_NOW_MS - runningElapsedMs,
  accumulatedMs: 0,
  lapStartElapsedMs: 33_710 + 28_970 + 31_120,
  laps: runningLaps,
};

// Stopped mid-session , frozen readout, Reset available, laps retained.
const stoppedState: StopwatchState = {
  running: false,
  startedAtMs: null,
  accumulatedMs: 124_320, // 02:04.32
  lapStartElapsedMs: 33_710 + 28_970 + 31_120,
  laps: runningLaps,
};

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Clock/Stopwatch",
  component: ClockStopwatchView,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    state: zeroState,
    nowMs: FIXED_NOW_MS,
    onStart: fn(),
    onStop: fn(),
    onLap: fn(),
    onReset: fn(),
  },
} satisfies Meta<typeof ClockStopwatchView>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Zero ─────────────────────────────────────────────────────────────────────

// Untouched: 00:00.00, disabled Lap on the left, accent Start on the right,
// no lap list.
export const Zero: Story = {};

// ─── Running with laps ────────────────────────────────────────────────────────

// Mid-run: live lap 4 on top, then laps newest-first with lap 2 accent-fastest
// and lap 3 muted-slowest; Lap + Stop buttons.
export const RunningWithLaps: Story = {
  args: { state: runningState },
};

// ─── Stopped ──────────────────────────────────────────────────────────────────

// Stopped mid-session: frozen readout, Reset replaces Lap, Start resumes.
export const Stopped: Story = {
  args: { state: stoppedState },
};
