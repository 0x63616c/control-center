/**
 * Stories for ClimateModalComfortPresetsFan , Presets & Airflow detail modal.
 * View-driven (all data + callbacks via props).
 *
 * Grouped under "Modals/" so it falls through the BoardDecorator's tile branch
 * to the plain dark wrapper, matching ExpandedControls story placement.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import type { ClimateZone } from "./ClimateModalComfortPresetsFan";
import { ClimateModalComfortPresetsFan } from "./ClimateModalComfortPresetsFan";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// Four real HA climate entities the house has: climate.ac, climate.bedroom,
// climate.home, climate.living_room. Attributes reflect realistic HA state.
const zones: ClimateZone[] = [
  {
    entityId: "climate.living_room",
    label: "Living Room",
    hvacAction: "cooling",
    presetMode: "home",
    presetModes: ["eco", "away", "home", "boost"],
    fanMode: "auto",
    fanModes: ["auto", "low", "medium", "high"],
  },
  {
    entityId: "climate.bedroom",
    label: "Bedroom",
    hvacAction: "idle",
    presetMode: "eco",
    presetModes: ["eco", "away", "home", "boost"],
    fanMode: "low",
    fanModes: ["auto", "low", "medium", "high"],
  },
  {
    entityId: "climate.ac",
    label: "AC",
    hvacAction: "cooling",
    presetMode: "boost",
    presetModes: ["eco", "away", "home", "boost"],
    fanMode: "high",
    fanModes: ["auto", "low", "medium", "high"],
  },
  {
    entityId: "climate.home",
    label: "Home",
    hvacAction: "off",
    presetMode: "away",
    presetModes: ["eco", "away", "home", "boost"],
    fanMode: "auto",
    fanModes: ["auto", "low", "medium", "high"],
  },
];

// A quieter night-time state: most zones idle or off, eco preset house-wide.
const nightZones: ClimateZone[] = [
  {
    entityId: "climate.living_room",
    label: "Living Room",
    hvacAction: "idle",
    presetMode: "eco",
    presetModes: ["eco", "away", "home", "boost"],
    fanMode: "auto",
    fanModes: ["auto", "low", "medium", "high"],
  },
  {
    entityId: "climate.bedroom",
    label: "Bedroom",
    hvacAction: "cooling",
    presetMode: "eco",
    presetModes: ["eco", "away", "home", "boost"],
    fanMode: "low",
    fanModes: ["auto", "low", "medium", "high"],
  },
  {
    entityId: "climate.ac",
    label: "AC",
    hvacAction: "off",
    presetMode: "away",
    presetModes: ["eco", "away", "home", "boost"],
    fanMode: "auto",
    fanModes: ["auto", "low", "medium", "high"],
  },
  {
    entityId: "climate.home",
    label: "Home",
    hvacAction: "off",
    presetMode: "away",
    presetModes: ["eco", "away", "home", "boost"],
    fanMode: "auto",
    fanModes: ["auto", "low", "medium", "high"],
  },
];

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Climate/Comfort Presets Fan",
  component: ClimateModalComfortPresetsFan,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    zones,
    onSetPreset: fn(),
    onSetFan: fn(),
  },
} satisfies Meta<typeof ClimateModalComfortPresetsFan>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Presets & Airflow , active cooling ───────────────────────────────────────

export const PresetsAndAirflow: Story = {
  name: "Presets & Airflow , active cooling",
};

// ─── Night mode , mostly idle, eco house-wide ─────────────────────────────────

export const NightMode: Story = {
  name: "Night mode , eco / mostly idle",
  args: { zones: nightZones },
};
