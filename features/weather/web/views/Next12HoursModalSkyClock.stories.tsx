/**
 * Stories for Next12HoursModalSkyClock , "Sky Clock" radial forecast modal.
 * Pure view (all data via props); no trpc/hooks so it composes in Storybook
 * without a provider. Grouped under "Modals/" per project convention.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import { Next12HoursModalSkyClock } from "./Next12HoursModalSkyClock";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// Realistic 12-hour slice: current hour "Now" + 11 future hours
// Los Angeles May afternoon , temps descend from mid-day into evening.
const hoursAfternoon = [
  { t: "Now", temp: 74, feels: 72, ic: "cloud-sun" },
  { t: "2p", temp: 76, feels: 74, ic: "sun" },
  { t: "3p", temp: 77, feels: 75, ic: "sun" },
  { t: "4p", temp: 76, feels: 74, ic: "cloud-sun" },
  { t: "5p", temp: 74, feels: 72, ic: "cloud" },
  { t: "6p", temp: 71, feels: 69, ic: "cloud" },
  { t: "7p", temp: 68, feels: 66, ic: "cloud" },
  { t: "8p", temp: 65, feels: 63, ic: "moon" },
  { t: "9p", temp: 63, feels: 61, ic: "moon" },
  { t: "10p", temp: 61, feels: 59, ic: "moon" },
  { t: "11p", temp: 59, feels: 57, ic: "moon" },
  { t: "12a", temp: 58, feels: 56, ic: "moon" },
];

const nowAfternoon = {
  temp: 74,
  cond: "Partly Cloudy",
  ic: "cloud-sun",
  sunrise: "6:08 AM",
  sunriseIso: "2026-05-31T06:08:00-07:00",
  sunset: "7:52 PM",
  sunsetIso: "2026-05-31T19:52:00-07:00",
  tomorrowSunriseIso: "2026-06-01T06:07:00-07:00",
};

// Early-morning variant: cool temps, all moon icons until dawn
const hoursMorning = [
  { t: "Now", temp: 58, feels: 56, ic: "moon" },
  { t: "4a", temp: 57, feels: 55, ic: "moon" },
  { t: "5a", temp: 57, feels: 55, ic: "moon" },
  { t: "6a", temp: 58, feels: 56, ic: "cloud-sun" },
  { t: "7a", temp: 61, feels: 59, ic: "cloud-sun" },
  { t: "8a", temp: 65, feels: 63, ic: "sun" },
  { t: "9a", temp: 68, feels: 66, ic: "sun" },
  { t: "10a", temp: 70, feels: 68, ic: "sun" },
  { t: "11a", temp: 72, feels: 70, ic: "cloud-sun" },
  { t: "12p", temp: 73, feels: 71, ic: "cloud-sun" },
  { t: "1p", temp: 74, feels: 72, ic: "cloud" },
  { t: "2p", temp: 75, feels: 73, ic: "cloud" },
];

const nowMorning = {
  temp: 58,
  cond: "Clear",
  ic: "moon",
  sunrise: "6:08 AM",
  sunriseIso: "2026-05-31T06:08:00-07:00",
  sunset: "7:52 PM",
  sunsetIso: "2026-05-31T19:52:00-07:00",
  tomorrowSunriseIso: "2026-06-01T06:07:00-07:00",
};

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Next 12 Hours/Sky Clock",
  component: Next12HoursModalSkyClock,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    hours: hoursAfternoon,
    now: nowAfternoon,
  },
} satisfies Meta<typeof Next12HoursModalSkyClock>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Primary: afternoon , warm afternoon into cool night ──────────────────────

export const SkyClock: Story = {
  name: "Sky Clock , afternoon",
};

// ─── Secondary: early morning , cool night into warming day ──────────────────

export const EarlyMorning: Story = {
  name: "Sky Clock , early morning",
  args: {
    hours: hoursMorning,
    now: nowMorning,
  },
};
