/**
 * Stories for EventsModalFullAgenda , the full upcoming-events agenda modal.
 * View-driven (all data + callbacks via props). Grouped under "Modals/" since
 * this is an overlay surface, not a tile, so it falls through the BoardDecorator
 * to the plain dark wrapper.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import { EventsModalFullAgenda } from "./EventsModalFullAgenda";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// A realistic full agenda with a mix of urgency states , some within the
// 3-day threshold (accented), some well out. Sorted ascending by days (soonest
// first) matching the router's pre-sorted output.
const fullAgendaEvents = [
  { name: "Dentist appointment", place: "Downtown Dental", days: 0 },
  { name: "Call with architect", place: "Google Meet", days: 1 },
  { name: "Dry cleaning pickup", place: "Martinizing on 6th", days: 3 },
  { name: "Birthday dinner , Maya", place: "Nobu Downtown LA", days: 7 },
  { name: "Oil change", place: "Jiffy Lube, Sunset Blvd", days: 9 },
  { name: "Flight to SF", place: "LAX Terminal 1", days: 14 },
  { name: "Conference , React Summit", place: "Moscone Center, SF", days: 15 },
  { name: "Return flight", place: "SFO Terminal 2", days: 17 },
  { name: "Lease renewal signing", place: "Apartment Leasing Office", days: 22 },
  { name: "Annual physical", place: "Cedars-Sinai Medical", days: 31 },
];

// A short list that matches exactly what the tile shows , verifies the modal
// adds value over the tile even when there are only a few events.
const shortAgendaEvents = [
  { name: "Coffee with Jordan", place: "Go Get Em Tiger, Silver Lake", days: 2 },
  { name: "Package delivery window", place: "Home", days: 4 },
  { name: "Haircut", place: "Fellow Barber, DTLA", days: 6 },
];

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Events/Full Agenda",
  component: EventsModalFullAgenda,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    events: fullAgendaEvents,
  },
} satisfies Meta<typeof EventsModalFullAgenda>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Full Agenda (interactive) ────────────────────────────────────────────────

export const FullAgenda: Story = {
  name: "Full Agenda , 10 events",
};

// ─── Short list ───────────────────────────────────────────────────────────────

// Fewer events than the tile's 3-event limit , the modal still shows them all
// with the same urgency language, no truncation.
export const ShortList: Story = {
  name: "Short list , 3 events",
  args: { events: shortAgendaEvents },
};

// ─── Empty ────────────────────────────────────────────────────────────────────

// No upcoming events in the DB , renders the empty state rather than an empty
// list, so the user knows the data loaded but there's simply nothing upcoming.
export const Empty: Story = {
  name: "Empty , no upcoming events",
  args: { events: [] },
};
