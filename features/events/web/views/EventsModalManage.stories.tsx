/**
 * Stories for EventsModalManage , the CRUD ("Manage") Events modal.
 * View-driven: create/update/delete arrive as callbacks (fn() spies here), the
 * add-form + inline-edit state is owned locally by the component. Grouped under
 * "Modals/" like the sibling Events variants.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import type { ManageEventRow } from "./EventsModalManage";
import { EventsModalManage } from "./EventsModalManage";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// A realistic upcoming list with real ISO dates + optional locations, matching
// the router's { id, name, place, days, date } output shape.
const manageEvents: ManageEventRow[] = [
  {
    id: 1,
    name: "Beltran , Factory 93",
    place: "1756 Naud St, DTLA",
    days: 0,
    date: "2026-07-11T20:00:00-07:00",
  },
  {
    id: 2,
    name: "Day Trip: OMNOM",
    place: "LA State Historic Park",
    days: 1,
    date: "2026-07-12T14:00:00-07:00",
  },
  {
    id: 3,
    name: "SOSA in LA",
    place: "Exposition Park",
    days: 7,
    date: "2026-07-18T18:00:00-07:00",
  },
  {
    id: 4,
    name: "Max Styler",
    place: "Shrine Expo Hall",
    days: 113,
    date: "2026-10-03T20:00:00-07:00",
  },
];

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Events/Manage",
  component: EventsModalManage,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    events: manageEvents,
    onCreate: fn(),
    onUpdate: fn(),
    onDelete: fn(),
    busy: false,
  },
} satisfies Meta<typeof EventsModalManage>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Manage (interactive) ─────────────────────────────────────────────────────

export const Manage: Story = {
  name: "Manage , 4 events",
};

// ─── Empty ────────────────────────────────────────────────────────────────────

// No events yet , the add form still shows so the user can create the first one.
export const Empty: Story = {
  name: "Empty , add the first event",
  args: { events: [] },
};

// ─── Busy ─────────────────────────────────────────────────────────────────────

// A mutation is in flight , action buttons are disabled to prevent double-submit.
export const Busy: Story = {
  name: "Busy , mutation in flight",
  args: { busy: true },
};
