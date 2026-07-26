/**
 * Stories for WeatherModalWeekOutlook , the 7-Day Outlook detail modal.
 * Grouped under "Modals/Weather". Pure view, no QueryClient needed.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import type { DayForecast } from "./WeatherModalWeekOutlook";
import { WeatherModalWeekOutlook } from "./WeatherModalWeekOutlook";

// ─── fixtures ─────────────────────────────────────────────────────────────────

/** Typical LA week: warm, then a marine-layer stretch with some rain chance. */
const typicalWeek: DayForecast[] = [
  { date: "2024-06-01", hi: 81, lo: 63, weatherCode: 1, precipProbability: 5 },
  { date: "2024-06-02", hi: 79, lo: 61, weatherCode: 2, precipProbability: 10 },
  { date: "2024-06-03", hi: 72, lo: 60, weatherCode: 3, precipProbability: 35 },
  { date: "2024-06-04", hi: 68, lo: 58, weatherCode: 61, precipProbability: 70 },
  { date: "2024-06-05", hi: 70, lo: 59, weatherCode: 80, precipProbability: 55 },
  { date: "2024-06-06", hi: 74, lo: 60, weatherCode: 2, precipProbability: 15 },
  { date: "2024-06-07", hi: 78, lo: 62, weatherCode: 1, precipProbability: 0 },
];

/** Narrow range , stress-test bar geometry when hi/lo are compressed. */
const narrowRangeWeek: DayForecast[] = [
  { date: "2024-11-15", hi: 65, lo: 58, weatherCode: 2, precipProbability: 20 },
  { date: "2024-11-16", hi: 64, lo: 57, weatherCode: 3, precipProbability: 40 },
  { date: "2024-11-17", hi: 63, lo: 57, weatherCode: 63, precipProbability: 80 },
  { date: "2024-11-18", hi: 66, lo: 58, weatherCode: 80, precipProbability: 60 },
  { date: "2024-11-19", hi: 67, lo: 59, weatherCode: 2, precipProbability: 25 },
  { date: "2024-11-20", hi: 68, lo: 60, weatherCode: 1, precipProbability: 5 },
  { date: "2024-11-21", hi: 69, lo: 61, weatherCode: 0, precipProbability: 0 },
];

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Weather/Week Outlook",
  component: WeatherModalWeekOutlook,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    todayHi: 81,
    todayLo: 63,
    days: typicalWeek,
  },
} satisfies Meta<typeof WeatherModalWeekOutlook>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── 7-Day Outlook (primary) ──────────────────────────────────────────────────

export const SevenDayOutlook: Story = {
  name: "7-Day Outlook",
};

// ─── Narrow range week ────────────────────────────────────────────────────────

export const NarrowRange: Story = {
  name: "Narrow range , compressed hi/lo",
  args: {
    todayHi: 65,
    todayLo: 58,
    days: narrowRangeWeek,
  },
};
