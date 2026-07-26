/**
 * Stories for TeslaModalLiveMapCommand , the "Live Map & Command" Tesla page body.
 *
 * Grouped under "Modals/" (not "Tiles/") , this is an overlay surface, not a
 * tile. The component is a bare page body now (hosted by TileDetailHost in the
 * app), so stories mount it inside a plain page-sized container matching the
 * host's content region. View-driven: all data + callbacks via props.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { modalDocsParameters, pageHostDecorator } from "../__stories__/factory";
import type { TeslaModalLiveMapCommandProps } from "./TeslaModalLiveMapCommand";
import { TeslaModalLiveMapCommand } from "./TeslaModalLiveMapCommand";

// ─── fixtures ─────────────────────────────────────────────────────────────────
// Realistic inline data grounded in actual sensor/entity values.
// device_tracker.evee_location: Koreatown, near Home.

const nearHome: TeslaModalLiveMapCommandProps = {
  lat: 34.063,
  lon: -118.285,
  place: "Home",
  locked: true,
  chargingState: "charging",
  batteryPct: 62,
  onToggleLock: fn(),
  onToggleCharge: fn(),
};

// Car parked downtown, idle, unlocked , a different state to exercise the
// lock/charge button labels and the distance-to-home readout.
const downtown: TeslaModalLiveMapCommandProps = {
  lat: 34.043,
  lon: -118.267,
  place: "Downtown LA",
  locked: false,
  chargingState: "stopped",
  batteryPct: 41,
  onToggleLock: fn(),
  onToggleCharge: fn(),
};

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Tesla/Live Map Command",
  component: TeslaModalLiveMapCommand,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: nearHome,
} satisfies Meta<typeof TeslaModalLiveMapCommand>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Live Map & Command , charging near home ──────────────────────────────────

export const LiveMapCommand: Story = {
  name: "Live Map & Command",
};

// ─── Downtown , unlocked, idle ────────────────────────────────────────────────

export const DowntownIdle: Story = {
  name: "Downtown , unlocked, idle",
  args: downtown,
};

// ─── No GPS , car asleep ──────────────────────────────────────────────────────
// When the car is asleep or HA loses the location, lat/lon are null.
// The map falls back to the home anchor; the distance readout shows ", mi".

export const NoGps: Story = {
  name: "No GPS , car asleep",
  args: {
    ...nearHome,
    lat: null,
    lon: null,
    place: "",
    chargingState: "disconnected",
    batteryPct: 88,
  },
};
