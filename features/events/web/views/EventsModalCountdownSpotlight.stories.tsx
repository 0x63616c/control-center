/**
 * Stories for EventsModalCountdownSpotlight , the hero countdown panel.
 * Grouped under "Modals/" (not "Tiles/") matching the ExpandedControls precedent.
 * Pure view: data + callbacks via props, no trpc.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import type { EventsModalCountdownSpotlightProps } from "./EventsModalCountdownSpotlight";
import { EventsModalCountdownSpotlight } from "./EventsModalCountdownSpotlight";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// Primary: soonest event is imminent (2 days), ring nearly full green.
const imminent: EventsModalCountdownSpotlightProps["events"] = [
  { name: "Gorgon City", place: "Sound Nightclub", days: 2 },
  { name: "Chris Lake", place: "Shrine Expo Hall", days: 10 },
  { name: "John Summit", place: "Hollywood Palladium", days: 54 },
  { name: "Four Tet", place: "Greek Theatre", days: 80 },
];

// Secondary: hero is comfortably far away (42 days), ring ~54% empty, dim color.
const comfortable: EventsModalCountdownSpotlightProps["events"] = [
  { name: "Bicep", place: "Kia Forum", days: 42 },
  { name: "Bonobo", place: "Ace Hotel", days: 67 },
  { name: "Floating Points", place: "The Wiltern", days: 88 },
];

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Events/Countdown Spotlight",
  component: EventsModalCountdownSpotlight,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    events: imminent,
  },
} satisfies Meta<typeof EventsModalCountdownSpotlight>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Next Up Countdown , imminent (hero ≤ 3 days, ring green, full) ───────────

export const NextUpCountdown: Story = {
  name: "Next Up Countdown , imminent",
  args: {
    events: imminent,
  },
};

// ─── Comfortable Distance , hero far away, ring dim + partial ─────────────────

export const ComfortableDistance: Story = {
  name: "Comfortable Distance , hero 42 days out",
  args: {
    events: comfortable,
  },
};

// ─── No Events , empty state ──────────────────────────────────────────────────

export const NoEvents: Story = {
  name: "Empty , no upcoming events",
  args: {
    events: [],
  },
};

// ─── Solo Hero , no peek list ─────────────────────────────────────────────────

export const SoloHero: Story = {
  name: "Solo Hero , only one event",
  args: {
    events: [{ name: "Disclosure", place: "Hollywood Bowl", days: 7 }],
  },
};
