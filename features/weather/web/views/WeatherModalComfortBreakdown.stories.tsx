/**
 * Stories for WeatherModalComfortBreakdown , the "Comfort & Conditions Panel"
 * detail modal for the Weather tile.
 *
 * Grouped under "Modals/Weather" (not "Tiles/") , overlays live here.
 * PURE view: all data via props.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import type { ComfortBreakdownData } from "./WeatherModalComfortBreakdown";
import { WeatherModalComfortBreakdown } from "./WeatherModalComfortBreakdown";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// Mild Los Angeles spring afternoon , comfortable across all metrics.
const mildAfternoon: ComfortBreakdownData = {
  temp: 72,
  feels: 70,
  hum: 48,
  wind: 6,
  cond: "Partly Cloudy",
  uvIndex: 5,
  precipProbability: 8,
};

// Overcast, breezy, humid morning , most gauges show caution.
const overcastBreezy: ComfortBreakdownData = {
  temp: 62,
  feels: 57,
  hum: 78,
  wind: 22,
  cond: "Overcast",
  uvIndex: 2,
  precipProbability: 65,
};

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Weather/Comfort Breakdown",
  component: WeatherModalComfortBreakdown,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    data: mildAfternoon,
  },
} satisfies Meta<typeof WeatherModalComfortBreakdown>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Comfort & Conditions Panel , mild afternoon ───────────────────────────

export const ComfortConditionsPanel: Story = {
  name: "Comfort & Conditions Panel",
  args: {
    data: mildAfternoon,
  },
};

// ─── Overcast & breezy , caution state ───────────────────────────────────────

export const OvercastBreezy: Story = {
  name: "Overcast & breezy , caution state",
  args: {
    data: overcastBreezy,
  },
};
