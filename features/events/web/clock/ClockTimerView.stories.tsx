/**
 * Stories for ClockTimerView , the Timer variant of the Clock detail page.
 * View-driven: timers + `nowMs` + callbacks all via props, pinned to fixed
 * fixture instants so remaining-time digits and ring fractions are
 * deterministic. Grouped under "Modals/Clock" with the kept clock pages ,
 * one Storybook tree. The component is a bare page body (hosted by
 * TileDetailHost in the app), so stories mount it inside a plain page-sized
 * container matching the host's content region.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import type { TimerRecord } from "@/lib/time-suite/types";
import { ClockTimerView } from "./ClockTimerView";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// Fixed "now" , Saturday 2026-05-30 21:37:00 UTC. All records are built
// relative to this instant so every story renders identical digits.
const NOW_MS = Date.UTC(2026, 4, 30, 21, 37, 0);

// Hero: a 10-minute tea timer with 4:12 left , ring just under half full.
const teaTimer: TimerRecord = {
  id: "timer_tea",
  label: "Tea",
  durationMs: 10 * 60_000,
  endsAtMs: NOW_MS + 4 * 60_000 + 12_000,
  remainingMs: 4 * 60_000 + 12_000,
  state: "running",
  doneAtMs: null,
  dismissedCue: false,
  createdAtMs: NOW_MS - 5 * 60_000 - 48_000,
};

// Grid trio: one running, one paused mid-way, one done and still ringing.
const pizzaTimer: TimerRecord = {
  id: "timer_pizza",
  label: "Pizza",
  durationMs: 25 * 60_000,
  endsAtMs: NOW_MS + 12 * 60_000 + 27_000,
  remainingMs: 12 * 60_000 + 27_000,
  state: "running",
  doneAtMs: null,
  dismissedCue: false,
  createdAtMs: NOW_MS - 12 * 60_000 - 33_000,
};

const laundryTimer: TimerRecord = {
  id: "timer_laundry",
  label: "Laundry",
  durationMs: 60 * 60_000,
  endsAtMs: null,
  remainingMs: 32 * 60_000 + 5_000,
  state: "paused",
  doneAtMs: null,
  dismissedCue: false,
  createdAtMs: NOW_MS - 40 * 60_000,
};

const doneTimer: TimerRecord = {
  id: "timer_eggs",
  label: null,
  durationMs: 5 * 60_000,
  endsAtMs: null,
  remainingMs: 0,
  state: "done",
  doneAtMs: NOW_MS - 12_000,
  dismissedCue: false,
  createdAtMs: NOW_MS - 5 * 60_000 - 12_000,
};

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Clock/Timer",
  component: ClockTimerView,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    timers: [],
    nowMs: NOW_MS,
    onAdd: fn(),
    onPause: fn(),
    onResume: fn(),
    onDelete: fn(),
    onDismiss: fn(),
    onRestart: fn(),
    onStopRinging: fn(),
  },
} satisfies Meta<typeof ClockTimerView>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Empty ────────────────────────────────────────────────────────────────────

// No timers: presets centered under the quiet line, Start disabled at 0:00:00.
export const Empty: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No timers running")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Start" })).toBeDisabled();
  },
};

// ─── One running ──────────────────────────────────────────────────────────────

// Single running timer: the centered hero card with the big thin digits and
// the accent border ring, New Timer rail on the right.
export const OneRunning: Story = {
  args: { timers: [teaTimer] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("4:12")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  },
};

// ─── Grid of three ────────────────────────────────────────────────────────────

// Running + paused + done-ringing side by side , the 2-column grid with the
// ringing card swapped to its accent-filled Stop state.
export const GridOfThree: Story = {
  args: { timers: [pizzaTimer, laundryTimer, doneTimer] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("12:27")).toBeInTheDocument();
    await expect(canvas.getByText("32:05")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  },
};
