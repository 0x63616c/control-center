/**
 * Stories for ClimateModalHouseThermalMap , the "House Thermal Map" detail modal.
 * Grouped under "Modals/Climate". All data is inline fixtures; no trpc/query
 * providers needed. View-only (no play functions) , POC-level verification.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import type { ClimateZone } from "./ClimateModalHouseThermalMap";
import { ClimateModalHouseThermalMap } from "./ClimateModalHouseThermalMap";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// Four real HA climate entities from the dashboard: climate.ac, climate.bedroom,
// climate.home, climate.living_room. Temps vary across a plausible afternoon
// spread so the gradient tinting across cells is exercised visually.
const ZONES_ACTIVE: ClimateZone[] = [
  {
    entityId: "climate.ac",
    name: "A/C",
    currentTemperature: 74,
    hvacAction: "cooling",
    hvacMode: "cool",
    hvacModes: ["off", "cool", "heat", "heat_cool"],
    targetTemperature: 72,
    targetTempLow: null,
    targetTempHigh: null,
    minTemp: 60,
    maxTemp: 90,
  },
  {
    entityId: "climate.bedroom",
    name: "Bedroom",
    currentTemperature: 71,
    hvacAction: "idle",
    hvacMode: "cool",
    hvacModes: ["off", "cool", "heat", "heat_cool"],
    targetTemperature: 71,
    targetTempLow: null,
    targetTempHigh: null,
    minTemp: 60,
    maxTemp: 90,
  },
  {
    entityId: "climate.home",
    name: "Home",
    currentTemperature: 78,
    hvacAction: "heating",
    hvacMode: "heat_cool",
    hvacModes: ["off", "cool", "heat", "heat_cool"],
    targetTemperature: null,
    targetTempLow: 68,
    targetTempHigh: 76,
    minTemp: 60,
    maxTemp: 90,
  },
  {
    entityId: "climate.living_room",
    name: "Living Room",
    currentTemperature: 68,
    hvacAction: "idle",
    hvacMode: "off",
    hvacModes: ["off", "cool", "heat", "heat_cool"],
    targetTemperature: null,
    targetTempLow: null,
    targetTempHigh: null,
    minTemp: 60,
    maxTemp: 90,
  },
];

// All zones off , a summer morning where nothing has kicked on yet.
// Temperatures tightly clustered in the cool range exercises the cold end of
// the gradient. Useful to confirm zones still render correctly with hvacMode off.
const ZONES_ALL_OFF: ClimateZone[] = [
  {
    entityId: "climate.ac",
    name: "A/C",
    currentTemperature: 65,
    hvacAction: "off",
    hvacMode: "off",
    hvacModes: ["off", "cool", "heat", "heat_cool"],
    targetTemperature: null,
    targetTempLow: null,
    targetTempHigh: null,
    minTemp: 60,
    maxTemp: 90,
  },
  {
    entityId: "climate.bedroom",
    name: "Bedroom",
    currentTemperature: 63,
    hvacAction: "off",
    hvacMode: "off",
    hvacModes: ["off", "cool", "heat", "heat_cool"],
    targetTemperature: null,
    targetTempLow: null,
    targetTempHigh: null,
    minTemp: 60,
    maxTemp: 90,
  },
  {
    entityId: "climate.home",
    name: "Home",
    currentTemperature: 66,
    hvacAction: "off",
    hvacMode: "off",
    hvacModes: ["off", "cool", "heat", "heat_cool"],
    targetTemperature: null,
    targetTempLow: null,
    targetTempHigh: null,
    minTemp: 60,
    maxTemp: 90,
  },
  {
    entityId: "climate.living_room",
    name: "Living Room",
    currentTemperature: 64,
    hvacAction: "off",
    hvacMode: "off",
    hvacModes: ["off", "cool", "heat", "heat_cool"],
    targetTemperature: null,
    targetTempLow: null,
    targetTempHigh: null,
    minTemp: 60,
    maxTemp: 90,
  },
];

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Climate/House Thermal Map",
  component: ClimateModalHouseThermalMap,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    zones: ZONES_ACTIVE,
    onSetMode: fn(),
    onSetTarget: fn(),
    onSetRange: fn(),
  },
} satisfies Meta<typeof ClimateModalHouseThermalMap>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── House Thermal Map , active zones ─────────────────────────────────────────

// Primary story: mixed actions (cooling, heating, idle, off) spread across a
// realistic afternoon temperature range. Cells are tinted by real current_temp,
// heat-cool band zone shows dual setpoints, A/C is actively cooling.
export const HouseThermalMap: Story = {
  name: "House Thermal Map",
};

// ─── All zones off ────────────────────────────────────────────────────────────

// Secondary story: every zone in off mode with temperatures clustered at the
// cool end of the scale. Confirms the cold half of the gradient is exercised and
// that zones with hvacMode 'off' render the "Off" setpoint line correctly.
export const AllZonesOff: Story = {
  name: "All Zones Off",
  args: { zones: ZONES_ALL_OFF },
};
