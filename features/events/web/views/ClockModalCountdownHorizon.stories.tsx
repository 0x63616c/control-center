/**
 * Stories for ClockModalCountdownHorizon , the "Countdown Horizon" clock detail
 * page body. Grouped under "Modals/Clock" , the component is a bare page body
 * now (hosted by TileDetailHost in the app), so stories mount it inside a plain
 * page-sized container matching the host's content region.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import { ClockModalCountdownHorizon } from "./ClockModalCountdownHorizon";

// ─── fixtures ─────────────────────────────────────────────────────────────────

/** A realistic spread of events across the next 45 days, including one today. */
const upcomingEvents = [
  { name: "Dentist appointment", place: "Smile Studio, Koreatown", days: 0 },
  { name: "Flight to NYC", place: "LAX Terminal 3", days: 3 },
  { name: "Team offsite", place: "Santa Monica, CA", days: 11 },
  { name: "Zero's vet checkup", place: "Silver Lake Animal Clinic", days: 18 },
  { name: "Car registration due", place: "DMV Los Feliz", days: 30 },
  { name: "Birthday dinner – Alex", place: "n/naka, Palms", days: 45 },
];

/** Events spread without any today, to show the non-today visual state. */
const futureOnlyEvents = [
  { name: "Flight to NYC", place: "LAX Terminal 3", days: 3 },
  { name: "Team offsite", place: "Santa Monica, CA", days: 11 },
  { name: "Zero's vet checkup", place: "Silver Lake Animal Clinic", days: 18 },
  { name: "Car registration due", place: "DMV Los Feliz", days: 30 },
];

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Clock/Countdown Horizon",
  component: ClockModalCountdownHorizon,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    todayLabel: "Saturday, May 31, 2026",
    events: upcomingEvents,
  },
} satisfies Meta<typeof ClockModalCountdownHorizon>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Primary: Countdown Horizon (today event + spread) ────────────────────────

export const CountdownHorizon: Story = {
  name: "Countdown Horizon , with today event",
};

// ─── Future only , no today event ─────────────────────────────────────────────

export const FutureOnly: Story = {
  name: "Countdown Horizon , future events only",
  args: {
    todayLabel: "Sunday, June 7, 2026",
    events: futureOnlyEvents,
  },
};

// ─── Single event ─────────────────────────────────────────────────────────────

export const SingleEvent: Story = {
  name: "Single event , ruler anchors to one point",
  args: {
    todayLabel: "Monday, June 1, 2026",
    events: [{ name: "Flight to NYC", place: "LAX Terminal 3", days: 7 }],
  },
};

// ─── Empty state ──────────────────────────────────────────────────────────────

export const Empty: Story = {
  name: "Empty , no upcoming events",
  args: {
    events: [],
  },
};
