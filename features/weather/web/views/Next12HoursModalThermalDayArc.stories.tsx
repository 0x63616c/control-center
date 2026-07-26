/**
 * Stories for Next12HoursModalThermalDayArc , the "Thermal Day Arc" detail modal.
 * Grouped under "Modals/Next 12 Hours" alongside other tile detail modals.
 * All data is inline fixtures; no trpc/query providers needed.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import type { ThermalHourEntry } from "./Next12HoursModalThermalDayArc";
import { Next12HoursModalThermalDayArc } from "./Next12HoursModalThermalDayArc";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// 24h of hourly data spanning a Los Angeles summer afternoon through the
// following morning. Temps peak late afternoon, drop overnight, recover
// toward the next day. Solar timestamps match real LA sunset/sunrise for a
// June day so the night band logic is exercised with genuine boundaries.
const HOURS_24: ThermalHourEntry[] = [
  { isoTime: "2025-06-01T13:00", label: "Now", temp: 82, feels: 80, weatherCode: 2 },
  { isoTime: "2025-06-01T14:00", label: "2 PM", temp: 84, feels: 82, weatherCode: 1 },
  { isoTime: "2025-06-01T15:00", label: "3 PM", temp: 86, feels: 84, weatherCode: 1 },
  { isoTime: "2025-06-01T16:00", label: "4 PM", temp: 87, feels: 85, weatherCode: 0 },
  { isoTime: "2025-06-01T17:00", label: "5 PM", temp: 85, feels: 83, weatherCode: 2 },
  { isoTime: "2025-06-01T18:00", label: "6 PM", temp: 81, feels: 79, weatherCode: 2 },
  { isoTime: "2025-06-01T19:00", label: "7 PM", temp: 76, feels: 75, weatherCode: 3 },
  { isoTime: "2025-06-01T20:00", label: "8 PM", temp: 71, feels: 70, weatherCode: 3 },
  { isoTime: "2025-06-01T21:00", label: "9 PM", temp: 68, feels: 67, weatherCode: 1 },
  { isoTime: "2025-06-01T22:00", label: "10 PM", temp: 65, feels: 64, weatherCode: 0 },
  { isoTime: "2025-06-01T23:00", label: "11 PM", temp: 63, feels: 62, weatherCode: 0 },
  { isoTime: "2025-06-02T00:00", label: "12 AM", temp: 61, feels: 60, weatherCode: 0 },
  { isoTime: "2025-06-02T01:00", label: "1 AM", temp: 60, feels: 59, weatherCode: 0 },
  { isoTime: "2025-06-02T02:00", label: "2 AM", temp: 59, feels: 58, weatherCode: 0 },
  { isoTime: "2025-06-02T03:00", label: "3 AM", temp: 58, feels: 57, weatherCode: 0 },
  { isoTime: "2025-06-02T04:00", label: "4 AM", temp: 57, feels: 56, weatherCode: 0 },
  { isoTime: "2025-06-02T05:00", label: "5 AM", temp: 58, feels: 57, weatherCode: 1 },
  { isoTime: "2025-06-02T06:00", label: "6 AM", temp: 61, feels: 60, weatherCode: 2 },
  { isoTime: "2025-06-02T07:00", label: "7 AM", temp: 65, feels: 63, weatherCode: 2 },
  { isoTime: "2025-06-02T08:00", label: "8 AM", temp: 69, feels: 67, weatherCode: 1 },
  { isoTime: "2025-06-02T09:00", label: "9 AM", temp: 73, feels: 71, weatherCode: 1 },
  { isoTime: "2025-06-02T10:00", label: "10 AM", temp: 77, feels: 75, weatherCode: 0 },
  { isoTime: "2025-06-02T11:00", label: "11 AM", temp: 80, feels: 78, weatherCode: 2 },
  { isoTime: "2025-06-02T12:00", label: "12 PM", temp: 83, feels: 81, weatherCode: 2 },
];

// Cloudy/rainy day: temps stay narrow, weatherCode shows rain codes so the
// readout card exercises the full WEATHER_CODES map.
const HOURS_RAINY: ThermalHourEntry[] = [
  { isoTime: "2025-06-01T08:00", label: "Now", temp: 62, feels: 59, weatherCode: 61 },
  { isoTime: "2025-06-01T09:00", label: "9 AM", temp: 63, feels: 60, weatherCode: 63 },
  { isoTime: "2025-06-01T10:00", label: "10 AM", temp: 64, feels: 61, weatherCode: 63 },
  { isoTime: "2025-06-01T11:00", label: "11 AM", temp: 64, feels: 60, weatherCode: 65 },
  { isoTime: "2025-06-01T12:00", label: "12 PM", temp: 65, feels: 61, weatherCode: 63 },
  { isoTime: "2025-06-01T13:00", label: "1 PM", temp: 66, feels: 62, weatherCode: 61 },
  { isoTime: "2025-06-01T14:00", label: "2 PM", temp: 65, feels: 61, weatherCode: 61 },
  { isoTime: "2025-06-01T15:00", label: "3 PM", temp: 64, feels: 60, weatherCode: 80 },
  { isoTime: "2025-06-01T16:00", label: "4 PM", temp: 63, feels: 59, weatherCode: 80 },
  { isoTime: "2025-06-01T17:00", label: "5 PM", temp: 62, feels: 59, weatherCode: 81 },
  { isoTime: "2025-06-01T18:00", label: "6 PM", temp: 61, feels: 58, weatherCode: 95 },
  { isoTime: "2025-06-01T19:00", label: "7 PM", temp: 60, feels: 57, weatherCode: 95 },
];

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Next 12 Hours/Thermal Day Arc",
  component: Next12HoursModalThermalDayArc,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    hours: HOURS_24,
    // LA June sunset ~8 PM, sunrise ~5:42 AM, tomorrow sunrise ~5:41 AM.
    sunsetIso: "2025-06-01T20:02",
    sunriseIso: "2025-06-01T05:42",
    tomorrowSunriseIso: "2025-06-02T05:41",
  },
} satisfies Meta<typeof Next12HoursModalThermalDayArc>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Thermal Day Arc , primary 24h view ───────────────────────────────────────

export const ThermalDayArc: Story = {
  name: "Thermal Day Arc , 24 h",
};

// ─── Rainy day , narrow temp range, rain condition codes ─────────────────────

export const RainyDay: Story = {
  name: "Rainy Day , narrow range, rain codes",
  args: {
    hours: HOURS_RAINY,
    // Morning start: both solar events are inside the chart window so both
    // sunrise and sunset rules appear, verifying the band + rule logic.
    sunriseIso: "2025-06-01T05:42",
    sunsetIso: "2025-06-01T20:02",
    tomorrowSunriseIso: "2025-06-02T05:41",
  },
};
