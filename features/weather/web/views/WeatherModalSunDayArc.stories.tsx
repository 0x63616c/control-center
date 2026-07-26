/**
 * Stories for WeatherModalSunDayArc , the "Sun Arc & Daylight" detail modal.
 * Grouped under "Modals/Weather" matching the tile family convention.
 * Pure view: all data + callbacks via props, no trpc.
 *
 * nowMs is a fixed snapshot in each story so the sun disc and countdowns render
 * deterministically regardless of when Storybook runs.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import { WeatherModalSunDayArc } from "./WeatherModalSunDayArc";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// LA solar times for 2026-05-31 , real Open-Meteo values for
// latitude 34.0537, longitude -118.2428. Solar noon = midpoint 05:58..20:02 = 12:59.

// Primary: mid-afternoon , sun is ~70% through its arc, about 4.5 hours to sunset.
// Countdown reads "4h 32m to sunset".
const midAfternoon = {
  sunriseIso: "2026-05-31T05:58:00",
  sunsetIso: "2026-05-31T20:02:00",
  tomorrowSunriseIso: "2026-06-01T05:57:00",
  nowMs: new Date("2026-05-31T15:30:00").getTime(),
};

// Secondary: golden hour , sun is close to the horizon at ~95% progress, disc
// sits near the right tip, countdown shows minutes. Stress-tests the near-sunset
// disc placement and "Xm to sunset" label format.
const goldenHour = {
  sunriseIso: "2026-05-31T05:58:00",
  sunsetIso: "2026-05-31T20:02:00",
  tomorrowSunriseIso: "2026-06-01T05:57:00",
  nowMs: new Date("2026-05-31T19:18:00").getTime(),
};

// Pre-dawn: sun has not risen , disc parks at the left tip, elapsed segment is
// absent, countdown reads "Xh Xm to sunrise".
const preDawn = {
  sunriseIso: "2026-05-31T05:58:00",
  sunsetIso: "2026-05-31T20:02:00",
  tomorrowSunriseIso: "2026-06-01T05:57:00",
  nowMs: new Date("2026-05-31T04:15:00").getTime(),
};

// After sunset: overnight countdown to tomorrow's sunrise, arc is fully unlit.
const afterSunset = {
  sunriseIso: "2026-05-31T05:58:00",
  sunsetIso: "2026-05-31T20:02:00",
  tomorrowSunriseIso: "2026-06-01T05:57:00",
  nowMs: new Date("2026-05-31T22:00:00").getTime(),
};

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Weather/Sun Day Arc",
  component: WeatherModalSunDayArc,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    ...midAfternoon,
  },
} satisfies Meta<typeof WeatherModalSunDayArc>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Sun Arc & Daylight , mid-afternoon (primary) ─────────────────────────────

export const SunDayArc: Story = {
  name: "Sun Arc & Daylight , mid-afternoon",
  args: midAfternoon,
};

// ─── Golden Hour , near sunset ────────────────────────────────────────────────

export const GoldenHour: Story = {
  name: "Golden Hour , disc near sunset tip",
  args: goldenHour,
};

// ─── Pre-Dawn , before sunrise ────────────────────────────────────────────────

export const PreDawn: Story = {
  name: "Pre-Dawn , counting down to sunrise",
  args: preDawn,
};

// ─── After Sunset , overnight countdown ──────────────────────────────────────

export const AfterSunset: Story = {
  name: "After Sunset , countdown to tomorrow's sunrise",
  args: afterSunset,
};
