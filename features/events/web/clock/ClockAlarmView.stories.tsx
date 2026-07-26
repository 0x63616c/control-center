/**
 * Stories for ClockAlarmView , the Clock detail page's Alarm variant.
 * View-driven: alarms/firing/nowMs and all callbacks via props (fixtures live
 * ONLY here , the app wires the alarm store through AlarmVariant). Grouped
 * under "Modals/Clock" with the kept clock pages so the Storybook tree stays
 * one clock cluster; mounted in a page-sized container standing in for the
 * TileDetailHost content region.
 *
 * `nowMs` is pinned so the `nextFireDescription` subtitles are deterministic.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import type { AlarmRecord } from "@/lib/time-suite/types";
import { ClockAlarmView } from "./ClockAlarmView";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// Fixed "now" , Wednesday 2026-06-10, midday UTC (mid-day in every panel-likely
// timezone, so one-shot Today/Tomorrow phrasing stays stable).
const NOW_MS = new Date("2026-06-10T12:00:00.000Z").getTime();

const weekdayAlarm: AlarmRecord = {
  id: "alarm_weekday",
  label: "Wake up",
  hour: 7,
  minute: 30,
  repeatDays: [1, 2, 3, 4, 5],
  enabled: true,
  nextFireAtMs: NOW_MS + 19 * 60 * 60_000,
};

const oneShotAlarm: AlarmRecord = {
  id: "alarm_oneshot",
  label: null,
  hour: 15,
  minute: 0,
  repeatDays: [],
  enabled: true,
  nextFireAtMs: NOW_MS + 2 * 60 * 60_000,
};

const disabledAlarm: AlarmRecord = {
  id: "alarm_disabled",
  label: "Stretch",
  hour: 21,
  minute: 15,
  repeatDays: [6, 7],
  enabled: false,
  nextFireAtMs: null,
};

const mixedAlarms = [weekdayAlarm, oneShotAlarm, disabledAlarm];

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Clock/Alarm",
  component: ClockAlarmView,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    alarms: mixedAlarms,
    firing: null,
    nowMs: NOW_MS,
    onAdd: fn(),
    onUpdate: fn(),
    onDelete: fn(),
    onToggle: fn(),
    onDismissFiring: fn(),
  },
} satisfies Meta<typeof ClockAlarmView>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Empty ────────────────────────────────────────────────────────────────────

// No alarms yet , quiet empty line plus the "+ New Alarm" entry point.
export const Empty: Story = {
  args: { alarms: [] },
};

// ─── Mixed list ───────────────────────────────────────────────────────────────

// Repeat + one-shot + disabled rows , the subtitle phrasing and the dimmed
// disabled treatment all visible at once.
export const MixedList: Story = {};

// ─── Editor open ──────────────────────────────────────────────────────────────

// Tap a row to expand the inline editor (wheels + AM/PM + day chips + label).
// Opened via play so the view's own tap-to-edit path is what's exercised.
export const EditorOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /7:30 AM/ }));
    await expect(canvas.getByRole("listbox", { name: "Hour" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Save" })).toBeInTheDocument();
  },
};

// ─── Firing ───────────────────────────────────────────────────────────────────

// A ringing alarm , full-width accent Stop bar above the list.
export const Firing: Story = {
  args: {
    firing: { alarmId: weekdayAlarm.id, sinceMs: NOW_MS - 10_000 },
    onDismissFiring: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const bar = canvas.getByRole("alert");
    await expect(bar).toHaveTextContent("Alarm — 7:30 AM · Wake up");
    await userEvent.click(within(bar).getByRole("button", { name: "Stop" }));
    await expect(args.onDismissFiring).toHaveBeenCalled();
  },
};
