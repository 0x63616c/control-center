/**
 * Stories for EventsModalMonthGrid , the "Calendar Heatmap" Events detail modal.
 * Grouped under "Modals/" so the BoardDecorator routes it to the plain dark wrapper.
 * All data + callbacks arrive via props; no trpc/hooks in the view.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import type { EventRowWithDate } from "./EventsModalMonthGrid";
import { EventsModalMonthGrid } from "./EventsModalMonthGrid";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// Pin "today" to a stable date so grid layout never shifts between runs.
// June 2026: starts on Monday (DOW 1), 30 days. Using LA-timezone ISO strings
// for the event dates since the DB stores timestamptz and daysUntil() operates
// in America/Los_Angeles.
const TODAY = "2026-06-01";

const typicalEvents: EventRowWithDate[] = [
  {
    name: "Housewarming – Alex & Sam",
    place: "Silver Lake, Los Angeles",
    days: 2,
    date: "2026-06-03T18:00:00-07:00",
  },
  {
    name: "Gallery Opening",
    place: "Hauser & Wirth, Downtown",
    days: 6,
    date: "2026-06-07T19:30:00-07:00",
  },
  {
    name: "Rooftop Concert",
    place: "The Wiltern, Koreatown",
    days: 6,
    date: "2026-06-07T21:00:00-07:00",
  },
  {
    name: "Farmers Market",
    place: "Hollywood, Ivar Ave",
    days: 13,
    date: "2026-06-14T09:00:00-07:00",
  },
  {
    name: "Dinner with Claire",
    place: "Osteria Mozza",
    days: 20,
    date: "2026-06-21T19:00:00-07:00",
  },
];

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Events/Month Grid",
  component: EventsModalMonthGrid,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    today: TODAY,
    events: typicalEvents,
  },
} satisfies Meta<typeof EventsModalMonthGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Calendar Heatmap , typical month ────────────────────────────────────────

// Primary story: a realistic June with events spread across the month, two on
// the same day (June 7) to verify the multi-event cell and strip expansion.
export const CalendarHeatmap: Story = {
  name: "Calendar Heatmap , typical month",
};

// ─── Empty month , no events ──────────────────────────────────────────────────

// Shows the grid cleanly with no accent dots , validates that empty state
// renders just the calendar without crashing or leaving dangling elements.
export const EmptyMonth: Story = {
  name: "Empty month , no events",
  args: {
    events: [],
  },
};

// ─── Packed week , cluster near start of month ────────────────────────────────

// Several events within the first 7 days, including one on day 1 (today) and
// one on day 3. Exercises the hotter heat tones (accent glow vs amber glow).
export const PackedWeek: Story = {
  name: "Packed week , cluster near start",
  args: {
    events: [
      {
        name: "Morning Run Club",
        place: "Griffith Park",
        days: 0,
        date: "2026-06-01T07:00:00-07:00",
      },
      {
        name: "Product Launch",
        place: "Row DTLA",
        days: 2,
        date: "2026-06-03T10:00:00-07:00",
      },
      {
        name: "Team Dinner",
        place: "Nobu, Malibu",
        days: 4,
        date: "2026-06-05T19:00:00-07:00",
      },
      {
        name: "Weekend Hike",
        place: "Runyon Canyon",
        days: 5,
        date: "2026-06-06T08:00:00-07:00",
      },
      {
        name: "Film Screening",
        place: "Egyptian Theatre",
        days: 6,
        date: "2026-06-07T20:00:00-07:00",
      },
    ],
  },
};
