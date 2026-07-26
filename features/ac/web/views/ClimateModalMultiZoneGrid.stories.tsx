/**
 * Stories for ClimateModalMultiZoneGrid , the multi-zone climate control modal.
 * View-driven (all data + callbacks via props). Grouped under "Modals/" since this
 * is an overlay surface, not a tile.
 *
 * Fixtures reflect the real HA entity IDs from climate-service.ts (climate.ac,
 * climate.bedroom, climate.home, climate.living_room) with realistic temperature
 * and mode values for Los Angeles in summer.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import type { ZoneData } from "./ClimateModalMultiZoneGrid";
import { ClimateModalMultiZoneGrid } from "./ClimateModalMultiZoneGrid";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// Four house zones matching climate-service.ts's getEntities('climate') output.
// Summer evening in LA: ac actively cooling, bedroom near setpoint/idle,
// living room in heat_cool auto-mode, and the main thermostat idle.
const allZones: ZoneData[] = [
  {
    entityId: "climate.ac",
    name: "A/C",
    mode: "cool",
    ambient: 76,
    target: 72,
    action: "cooling",
    supportedModes: ["off", "cool", "heat", "heat_cool"],
    minTemp: 65,
    maxTemp: 80,
  },
  {
    entityId: "climate.bedroom",
    name: "Bedroom",
    mode: "cool",
    ambient: 70,
    target: 69,
    action: "idle",
    supportedModes: ["off", "cool", "heat"],
    minTemp: 65,
    maxTemp: 80,
  },
  {
    entityId: "climate.home",
    name: "Home",
    mode: "heat_cool",
    ambient: 73,
    targetLow: 68,
    targetHigh: 76,
    action: "idle",
    supportedModes: ["off", "cool", "heat", "heat_cool", "fan_only"],
    minTemp: 65,
    maxTemp: 80,
  },
  {
    entityId: "climate.living_room",
    name: "Living Room",
    mode: "cool",
    ambient: 74,
    target: 71,
    action: "cooling",
    supportedModes: ["off", "cool", "heat", "heat_cool"],
    minTemp: 65,
    maxTemp: 80,
  },
];

// All zones off , e.g. nobody home, thermostat schedule paused.
const allOffZones: ZoneData[] = allZones.map((z) => ({
  ...z,
  mode: "off" as const,
  action: "off" as const,
}));

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Climate/Multi Zone Grid",
  component: ClimateModalMultiZoneGrid,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    zones: allZones,
    onSetMode: fn(),
    onSetTarget: fn(),
    onSetRange: fn(),
  },
} satisfies Meta<typeof ClimateModalMultiZoneGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Multi-Zone Control ───────────────────────────────────────────────────────

export const MultiZoneControl: Story = {
  name: "Multi-Zone Control , 4 zones",
};

// ─── All zones off ────────────────────────────────────────────────────────────

// Renders when nobody is home / thermostat schedule is paused. Every card shows
// the Off pill and no slider; mode chips still let the user turn a zone back on.
export const AllOff: Story = {
  name: "All zones off , away mode",
  args: { zones: allOffZones },
};
