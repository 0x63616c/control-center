/**
 * Stories for WeatherModalHourlyTempCurve , the "24h Temperature & Feels Curve"
 * detail modal for the Weather tile.
 *
 * Grouped under "Modals/Weather" so Storybook lists it beside other modal
 * surfaces, not under the tile hierarchy.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import type { HourlySlot, WeatherModalHourlyTempCurveProps } from "./WeatherModalHourlyTempCurve";
import { WeatherModalHourlyTempCurve } from "./WeatherModalHourlyTempCurve";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// 24-slot LA afternoon-into-night sequence , temps realistic for early-summer LA.
// is_day follows actual solar logic: day ends around 8PM (slot index 8 from 12PM).
const LA_AFTERNOON_24H: HourlySlot[] = [
  { t: "Now", temp: 74, feels: 73, ic: "cloud-sun", isDay: true },
  { t: "1PM", temp: 76, feels: 75, ic: "sun", isDay: true },
  { t: "2PM", temp: 78, feels: 77, ic: "sun", isDay: true },
  { t: "3PM", temp: 80, feels: 79, ic: "sun", isDay: true },
  { t: "4PM", temp: 81, feels: 80, ic: "sun", isDay: true },
  { t: "5PM", temp: 79, feels: 78, ic: "cloud-sun", isDay: true },
  { t: "6PM", temp: 76, feels: 75, ic: "cloud-sun", isDay: true },
  { t: "7PM", temp: 73, feels: 71, ic: "cloud", isDay: true },
  { t: "8PM", temp: 70, feels: 68, ic: "cloud", isDay: false },
  { t: "9PM", temp: 67, feels: 66, ic: "moon", isDay: false },
  { t: "10PM", temp: 65, feels: 64, ic: "moon", isDay: false },
  { t: "11PM", temp: 63, feels: 62, ic: "moon", isDay: false },
  { t: "12AM", temp: 62, feels: 61, ic: "moon", isDay: false },
  { t: "1AM", temp: 61, feels: 60, ic: "moon", isDay: false },
  { t: "2AM", temp: 60, feels: 59, ic: "moon", isDay: false },
  { t: "3AM", temp: 59, feels: 58, ic: "moon", isDay: false },
  { t: "4AM", temp: 58, feels: 57, ic: "moon", isDay: false },
  { t: "5AM", temp: 59, feels: 58, ic: "moon", isDay: false },
  { t: "6AM", temp: 61, feels: 60, ic: "cloud-sun", isDay: true },
  { t: "7AM", temp: 63, feels: 62, ic: "cloud-sun", isDay: true },
  { t: "8AM", temp: 66, feels: 65, ic: "sun", isDay: true },
  { t: "9AM", temp: 68, feels: 67, ic: "sun", isDay: true },
  { t: "10AM", temp: 71, feels: 70, ic: "sun", isDay: true },
  { t: "11AM", temp: 73, feels: 72, ic: "cloud-sun", isDay: true },
];

// Overcast / marine-layer day , tight temp/feels divergence, all cloud icons,
// mixed day/night band (overcast but still technically daytime for most slots).
const MARINE_LAYER_24H: HourlySlot[] = [
  { t: "Now", temp: 65, feels: 63, ic: "cloud", isDay: true },
  { t: "1PM", temp: 66, feels: 64, ic: "cloud", isDay: true },
  { t: "2PM", temp: 67, feels: 65, ic: "cloud", isDay: true },
  { t: "3PM", temp: 67, feels: 65, ic: "cloud", isDay: true },
  { t: "4PM", temp: 66, feels: 64, ic: "cloud", isDay: true },
  { t: "5PM", temp: 65, feels: 63, ic: "cloud", isDay: true },
  { t: "6PM", temp: 64, feels: 62, ic: "cloud", isDay: true },
  { t: "7PM", temp: 63, feels: 61, ic: "cloud", isDay: false },
  { t: "8PM", temp: 62, feels: 60, ic: "cloud", isDay: false },
  { t: "9PM", temp: 61, feels: 59, ic: "cloud", isDay: false },
  { t: "10PM", temp: 60, feels: 58, ic: "cloud", isDay: false },
  { t: "11PM", temp: 60, feels: 58, ic: "cloud", isDay: false },
  { t: "12AM", temp: 59, feels: 57, ic: "cloud", isDay: false },
  { t: "1AM", temp: 59, feels: 57, ic: "cloud", isDay: false },
  { t: "2AM", temp: 58, feels: 56, ic: "cloud", isDay: false },
  { t: "3AM", temp: 58, feels: 56, ic: "cloud", isDay: false },
  { t: "4AM", temp: 57, feels: 55, ic: "cloud", isDay: false },
  { t: "5AM", temp: 57, feels: 55, ic: "cloud", isDay: false },
  { t: "6AM", temp: 58, feels: 56, ic: "cloud", isDay: true },
  { t: "7AM", temp: 59, feels: 57, ic: "cloud", isDay: true },
  { t: "8AM", temp: 60, feels: 58, ic: "cloud", isDay: true },
  { t: "9AM", temp: 62, feels: 60, ic: "cloud", isDay: true },
  { t: "10AM", temp: 63, feels: 61, ic: "cloud", isDay: true },
  { t: "11AM", temp: 64, feels: 62, ic: "cloud", isDay: true },
];

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Weather/Hourly Temp Curve",
  component: WeatherModalHourlyTempCurve,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    slots: LA_AFTERNOON_24H,
    currentTemp: 74,
    currentFeels: 73,
    dailyHi: 81,
    dailyLo: 58,
  } satisfies WeatherModalHourlyTempCurveProps,
} satisfies Meta<typeof WeatherModalHourlyTempCurve>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Primary: clear afternoon into night ──────────────────────────────────────

// The main use case: a warm LA afternoon with a visible day/night band transition,
// a clear temp/feels divergence, and the full 24-slot window.
export const AfternoonIntoNight: Story = {
  name: "24h Temperature & Feels Curve , afternoon",
  args: {
    slots: LA_AFTERNOON_24H,
    currentTemp: 74,
    currentFeels: 73,
    dailyHi: 81,
    dailyLo: 58,
  },
};

// ─── Secondary: marine layer overcast ─────────────────────────────────────────

// Overcast marine-layer day: narrow temp/feels spread, no sun icons, minimal
// day/night visual contrast , confirms the chart reads clearly even with a flat,
// compressed range and no bright daytime bands.
export const MarineLayerOvercast: Story = {
  name: "Marine layer , narrow spread, all cloud",
  args: {
    slots: MARINE_LAYER_24H,
    currentTemp: 65,
    currentFeels: 63,
    dailyHi: 67,
    dailyLo: 57,
  },
};
