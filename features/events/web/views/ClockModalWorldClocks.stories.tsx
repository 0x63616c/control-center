/**
 * Stories for ClockModalWorldClocks , world-clocks expanded view for the Clock tile.
 * View-driven: all data + callbacks via props. Grouped under "Modals/Clock" ,
 * the component is a bare page body now (hosted by TileDetailHost in the app),
 * so stories mount it inside a plain page-sized container matching the host's
 * content region.
 *
 * `now` is pinned to a fixed Date so snapshots are deterministic , the actual
 * board passes a live ticking Date.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import { ClockModalWorldClocks } from "./ClockModalWorldClocks";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// Fixed "now" , Saturday 2026-05-30 at 14:37 Los Angeles time (UTC-7).
// Chosen so the LA row shows afternoon and Tokyo/Sydney show different day states.
const fixedNow = new Date("2026-05-30T21:37:00.000Z");

// Full world spread: home (LA) + four major zones.
const globalZones = [
  { city: "Los Angeles", tz: "America/Los_Angeles", home: true },
  { city: "New York", tz: "America/New_York" },
  { city: "London", tz: "Europe/London" },
  { city: "Tokyo", tz: "Asia/Tokyo" },
  { city: "Sydney", tz: "Australia/Sydney" },
];

// Minimal set , home only, verifying the panel renders cleanly with a single row.
const homeOnlyZones = [{ city: "Los Angeles", tz: "America/Los_Angeles", home: true }];

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Clock/World Clocks",
  component: ClockModalWorldClocks,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    now: fixedNow,
    zones: globalZones,
  },
} satisfies Meta<typeof ClockModalWorldClocks>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── World Clocks ─────────────────────────────────────────────────────────────

export const WorldClocks: Story = {
  name: "World Clocks , 5 zones",
};

// ─── Home only ────────────────────────────────────────────────────────────────

// Single home row , verifies the divider doesn't render and the accent styling
// applies correctly when there are no other zones.
export const HomeOnly: Story = {
  name: "Home only , Los Angeles",
  args: { zones: homeOnlyZones },
};
