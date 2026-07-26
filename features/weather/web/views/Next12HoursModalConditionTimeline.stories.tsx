/**
 * Stories for Next12HoursModalConditionTimeline , Condition Timeline POC.
 *
 * Grouped under "Modals/" (not "Tiles/") since this is an overlay surface.
 * All data is inline fixture data that mirrors the real API shape , no
 * fake-data sentinel identifiers.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import { Next12HoursModalConditionTimeline } from "./Next12HoursModalConditionTimeline";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// Afternoon in Los Angeles: starts at 1 PM, crosses sunset at 7:52 PM into overnight.
// Mirrors Open-Meteo shape , ISO timestamps are location-local.
const LA_SUMMER_AFTERNOON = {
  sunriseIso: "2024-06-01T05:48",
  sunsetIso: "2024-06-01T19:52",
  tomorrowSunriseIso: "2024-06-02T05:48",
  sunrise: "5:48 AM",
  sunset: "7:52 PM",
  hours: [
    {
      iso: "2024-06-01T13:00",
      t: "Now",
      temp: 80,
      feels: 78,
      ic: "sun" as const,
      cond: "Clear Sky",
    },
    {
      iso: "2024-06-01T14:00",
      t: "2PM",
      temp: 82,
      feels: 80,
      ic: "sun" as const,
      cond: "Mainly Clear",
    },
    {
      iso: "2024-06-01T15:00",
      t: "3PM",
      temp: 84,
      feels: 82,
      ic: "sun" as const,
      cond: "Clear Sky",
    },
    {
      iso: "2024-06-01T16:00",
      t: "4PM",
      temp: 83,
      feels: 81,
      ic: "cloud-sun" as const,
      cond: "Partly Cloudy",
    },
    {
      iso: "2024-06-01T17:00",
      t: "5PM",
      temp: 80,
      feels: 79,
      ic: "cloud-sun" as const,
      cond: "Partly Cloudy",
    },
    {
      iso: "2024-06-01T18:00",
      t: "6PM",
      temp: 76,
      feels: 75,
      ic: "cloud" as const,
      cond: "Overcast",
    },
    {
      iso: "2024-06-01T19:00",
      t: "7PM",
      temp: 73,
      feels: 72,
      ic: "cloud" as const,
      cond: "Overcast",
    },
    {
      iso: "2024-06-01T20:00",
      t: "8PM",
      temp: 70,
      feels: 69,
      ic: "moon" as const,
      cond: "Mainly Clear",
    },
    {
      iso: "2024-06-01T21:00",
      t: "9PM",
      temp: 68,
      feels: 67,
      ic: "moon" as const,
      cond: "Clear Sky",
    },
    {
      iso: "2024-06-01T22:00",
      t: "10PM",
      temp: 66,
      feels: 65,
      ic: "moon" as const,
      cond: "Clear Sky",
    },
    {
      iso: "2024-06-01T23:00",
      t: "11PM",
      temp: 65,
      feels: 64,
      ic: "moon" as const,
      cond: "Mainly Clear",
    },
    {
      iso: "2024-06-02T00:00",
      t: "12AM",
      temp: 63,
      feels: 62,
      ic: "moon" as const,
      cond: "Mainly Clear",
    },
  ],
};

// Winter morning crossing from overnight into daytime , tests the phase
// boundary when the first entry is pre-sunrise (overnight) and later entries
// are daytime. Also exercises rain/drizzle condition strings.
const LA_WINTER_MORNING = {
  sunriseIso: "2024-12-01T06:42",
  sunsetIso: "2024-12-01T16:48",
  tomorrowSunriseIso: "2024-12-02T06:43",
  sunrise: "6:42 AM",
  sunset: "4:48 PM",
  hours: [
    {
      iso: "2024-12-01T04:00",
      t: "Now",
      temp: 52,
      feels: 49,
      ic: "cloud" as const,
      cond: "Overcast",
    },
    {
      iso: "2024-12-01T05:00",
      t: "5AM",
      temp: 51,
      feels: 48,
      ic: "cloud" as const,
      cond: "Overcast",
    },
    {
      iso: "2024-12-01T06:00",
      t: "6AM",
      temp: 50,
      feels: 47,
      ic: "cloud" as const,
      cond: "Light Drizzle",
    },
    {
      iso: "2024-12-01T07:00",
      t: "7AM",
      temp: 51,
      feels: 48,
      ic: "cloud" as const,
      cond: "Light Drizzle",
    },
    {
      iso: "2024-12-01T08:00",
      t: "8AM",
      temp: 53,
      feels: 50,
      ic: "cloud" as const,
      cond: "Moderate Drizzle",
    },
    {
      iso: "2024-12-01T09:00",
      t: "9AM",
      temp: 55,
      feels: 52,
      ic: "cloud" as const,
      cond: "Slight Rain",
    },
    {
      iso: "2024-12-01T10:00",
      t: "10AM",
      temp: 56,
      feels: 53,
      ic: "cloud" as const,
      cond: "Slight Rain",
    },
    {
      iso: "2024-12-01T11:00",
      t: "11AM",
      temp: 57,
      feels: 54,
      ic: "cloud-sun" as const,
      cond: "Partly Cloudy",
    },
    {
      iso: "2024-12-01T12:00",
      t: "12PM",
      temp: 59,
      feels: 56,
      ic: "cloud-sun" as const,
      cond: "Partly Cloudy",
    },
    {
      iso: "2024-12-01T13:00",
      t: "1PM",
      temp: 60,
      feels: 57,
      ic: "sun" as const,
      cond: "Mainly Clear",
    },
    {
      iso: "2024-12-01T14:00",
      t: "2PM",
      temp: 61,
      feels: 58,
      ic: "sun" as const,
      cond: "Clear Sky",
    },
    {
      iso: "2024-12-01T15:00",
      t: "3PM",
      temp: 60,
      feels: 57,
      ic: "cloud-sun" as const,
      cond: "Partly Cloudy",
    },
  ],
};

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Next 12 Hours/Condition Timeline",
  component: Next12HoursModalConditionTimeline,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    ...LA_SUMMER_AFTERNOON,
  },
} satisfies Meta<typeof Next12HoursModalConditionTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Condition Timeline , LA summer afternoon ─────────────────────────────────

// Primary story: afternoon in LA crossing sunset from daytime into overnight.
// The sticky "Daytime · until 7:52 PM" and "Overnight · from 7:52 PM" headers
// illustrate the solar-phase segmentation that makes this layout unique.
export const ConditionTimeline: Story = {
  name: "Condition Timeline , summer afternoon",
};

// ─── Winter morning , rain conditions ────────────────────────────────────────

// Secondary story: pre-dawn to afternoon, exercising overnight→daytime phase
// boundary and WMO rain/drizzle condition strings rarely seen in summer fixtures.
export const WinterMorning: Story = {
  name: "Winter morning , rain + phase crossing",
  args: LA_WINTER_MORNING,
};
