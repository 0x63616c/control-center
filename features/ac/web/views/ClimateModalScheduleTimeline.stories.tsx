/**
 * Stories for ClimateModalScheduleTimeline , the "Comfort Schedule" Climate modal.
 * View-driven (all data + callbacks via props), matches the ExpandedControls
 * story shape: grouped under "Modals/", autodocs, fn() callbacks.
 *
 * Fixtures use realistic temperatures and zone names from the real HA entities
 * (climate.ac, climate.bedroom, climate.home, climate.living_room).
 * NOW is pinned to hour 14 so the "now" caret and active-segment readout are
 * deterministic in snapshots regardless of when the story runs.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import type { ScheduleZone } from "./ClimateModalScheduleTimeline";
import { ClimateModalScheduleTimeline } from "./ClimateModalScheduleTimeline";

// ─── fixtures ─────────────────────────────────────────────────────────────────

/** Pinned story hour (2pm) so the "now" caret and active-segment label are stable. */
const STORY_NOW_HOUR = 14;

/** A typical afternoon schedule for the main A/C (climate.ac).
 *  Cool overnight, ease off mid-morning, push down through afternoon heat. */
const acZone: ScheduleZone = {
  entityId: "climate.ac",
  name: "A/C",
  ambient: 73.5,
  currentTarget: 72,
  action: "cooling",
  minTemp: 65,
  maxTemp: 80,
  segments: [
    { startHour: 0, setpoint: 70 },
    { startHour: 6, setpoint: 73 },
    { startHour: 9, setpoint: 75 },
    { startHour: 12, setpoint: 72 },
    { startHour: 17, setpoint: 70 },
    { startHour: 22, setpoint: 70 },
  ],
};

/** Bedroom stays a couple degrees cooler for sleep comfort. */
const bedroomZone: ScheduleZone = {
  entityId: "climate.bedroom",
  name: "Bedroom",
  ambient: 71.2,
  currentTarget: 69,
  action: "idle",
  minTemp: 65,
  maxTemp: 80,
  segments: [
    { startHour: 0, setpoint: 68 },
    { startHour: 7, setpoint: 72 },
    { startHour: 10, setpoint: 74 },
    { startHour: 22, setpoint: 68 },
  ],
};

/** Living room runs warmer during the day. */
const livingRoomZone: ScheduleZone = {
  entityId: "climate.living_room",
  name: "Living Rm",
  ambient: 74.8,
  currentTarget: 73,
  action: "cooling",
  minTemp: 65,
  maxTemp: 80,
  segments: [
    { startHour: 0, setpoint: 72 },
    { startHour: 8, setpoint: 74 },
    { startHour: 18, setpoint: 72 },
    { startHour: 23, setpoint: 71 },
  ],
};

/** Home zone (the HA "home" thermostat , whole-unit). */
const homeZone: ScheduleZone = {
  entityId: "climate.home",
  name: "Home",
  ambient: 72.0,
  currentTarget: 72,
  action: "idle",
  minTemp: 65,
  maxTemp: 80,
  segments: [
    { startHour: 0, setpoint: 71 },
    { startHour: 8, setpoint: 73 },
    { startHour: 14, setpoint: 72 },
    { startHour: 21, setpoint: 70 },
  ],
};

/** All four house zones , the primary story state. */
const allZones: ScheduleZone[] = [acZone, bedroomZone, livingRoomZone, homeZone];

/** Single-zone slice , useful for showing a focused/minimal state and for
 *  checking that the layout doesn't collapse with fewer rows. */
const singleZone: ScheduleZone[] = [acZone];

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Climate/Schedule Timeline",
  component: ClimateModalScheduleTimeline,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    zones: allZones,
    nowHour: STORY_NOW_HOUR,
    onApplyNow: fn(),
    onSetSegment: fn(),
  },
} satisfies Meta<typeof ClimateModalScheduleTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Comfort Schedule (primary , all four zones, 2pm) ─────────────────────────

export const ComfortSchedule: Story = {
  name: "Comfort Schedule , all zones, 2pm",
};

// ─── Single zone , minimal layout ─────────────────────────────────────────────

export const SingleZone: Story = {
  name: "Single zone , A/C only",
  args: {
    zones: singleZone,
    nowHour: 9,
  },
};

// ─── All idle , no active cooling/heating ─────────────────────────────────────

export const AllIdle: Story = {
  name: "All idle , no active zones",
  args: {
    zones: allZones.map((z) => ({ ...z, action: "idle" as const })),
  },
};

// ─── No zones , empty state ────────────────────────────────────────────────────

export const NoZones: Story = {
  name: "Empty , no zones available",
  args: {
    zones: [],
  },
};
