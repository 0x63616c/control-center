/**
 * Stories for TeslaModalVehicleVitals , the "act on the car" detail page body.
 *
 * Grouped under "Modals/Tesla" (not "Tiles/") since this is an overlay surface.
 * The component is a bare page body now (hosted by TileDetailHost in the app),
 * so stories mount it inside a plain page-sized container matching the host's
 * content region. View-driven: all data + callbacks via props.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { modalDocsParameters, pageHostDecorator } from "../__stories__/factory";
import { TeslaModalVehicleVitals } from "./TeslaModalVehicleVitals";

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Tesla/Vehicle Vitals",
  component: TeslaModalVehicleVitals,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    onToggleLock: fn(),
    onTogglePrecondition: fn(),
  },
} satisfies Meta<typeof TeslaModalVehicleVitals>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Vehicle Vitals , parked at home, locked, not charging ────────────────────

export const VehicleVitals: Story = {
  name: "Vehicle Vitals",
  args: {
    locked: true,
    lockPending: false,
    cabinTempF: 74,
    preconditioning: false,
    preconditionPending: false,
    batteryPct: 82,
    rangeMiles: 241,
    odometer: "18,432 mi",
    chargingState: "disconnected",
    placeName: "Home",
  },
};

// ─── Charging + Preconditioning active ────────────────────────────────────────

// Shows the accent-green "charging" pill, battery ring at a lower level, and
// preconditioning tap in the active state , the page at its busiest.
export const ChargingPreconditioningActive: Story = {
  name: "Charging + Preconditioning active",
  args: {
    locked: true,
    lockPending: false,
    cabinTempF: 68,
    preconditioning: true,
    preconditionPending: false,
    batteryPct: 34,
    rangeMiles: 99,
    odometer: "18,432 mi",
    chargingState: "charging",
    placeName: "Home",
  },
};

// ─── Unlocked + Low battery ───────────────────────────────────────────────────

// Amber lock pill + amber battery ring (<= 20%) gives a visual warning at a glance.
export const UnlockedLowBattery: Story = {
  name: "Unlocked , low battery",
  args: {
    locked: false,
    lockPending: false,
    cabinTempF: 91,
    preconditioning: false,
    preconditionPending: false,
    batteryPct: 14,
    rangeMiles: 38,
    odometer: "18,432 mi",
    chargingState: "stopped",
    placeName: "Downtown LA",
  },
};

// ─── Asleep / car sleeping ────────────────────────────────────────────────────

// Odometer shows "," (sensor returns this when the car is asleep/disabled).
export const CarAsleep: Story = {
  name: "Car asleep , odometer unavailable",
  args: {
    locked: true,
    lockPending: false,
    cabinTempF: 78,
    preconditioning: false,
    preconditionPending: false,
    batteryPct: 71,
    rangeMiles: 209,
    odometer: ",",
    chargingState: "disconnected",
    placeName: "Home",
  },
};
