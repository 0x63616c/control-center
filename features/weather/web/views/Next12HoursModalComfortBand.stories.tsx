/**
 * Stories for Next12HoursModalComfortBand , the "Comfort & Layer Advisor"
 * detail modal. View-driven (all data + callbacks via props), no trpc/hooks.
 * Grouped under "Modals/" so it falls through the BoardDecorator to the plain
 * dark wrapper, matching the ExpandedControls story structure.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import type { HourlyEntry } from "../Next12HoursView";
import { Next12HoursModalComfortBand } from "./Next12HoursModalComfortBand";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// Afternoon-into-night window: starts warm, drops through mild/cool/cold by
// midnight. The 6PM→7PM slot is the sharpest drop (-5° feels) , a meaningful
// "put your jacket in the bag" signal.
const EVENING_HOURS: HourlyEntry[] = [
  { t: "Now", temp: 78, feels: 76, ic: "sun" },
  { t: "2PM", temp: 80, feels: 78, ic: "sun" },
  { t: "3PM", temp: 81, feels: 79, ic: "sun" },
  { t: "4PM", temp: 79, feels: 77, ic: "cloud-sun" },
  { t: "5PM", temp: 75, feels: 73, ic: "cloud-sun" },
  { t: "6PM", temp: 70, feels: 68, ic: "cloud" },
  { t: "7PM", temp: 65, feels: 63, ic: "cloud" },
  { t: "8PM", temp: 62, feels: 60, ic: "moon" },
  { t: "9PM", temp: 60, feels: 58, ic: "moon" },
  { t: "10PM", temp: 58, feels: 55, ic: "moon" },
  { t: "11PM", temp: 56, feels: 52, ic: "moon" },
  { t: "12AM", temp: 54, feels: 48, ic: "moon" },
];

// Cold morning window: stays below 55° all 12 hours , every band slot shows
// "cold" or "cool", verifying the ribbon renders correctly without warm/mild
// segments and that the swing callout shows a rise (temperature warming up).
const COLD_MORNING_HOURS: HourlyEntry[] = [
  { t: "Now", temp: 44, feels: 40, ic: "moon" },
  { t: "2AM", temp: 43, feels: 39, ic: "moon" },
  { t: "3AM", temp: 42, feels: 38, ic: "moon" },
  { t: "4AM", temp: 42, feels: 38, ic: "moon" },
  { t: "5AM", temp: 43, feels: 40, ic: "moon" },
  { t: "6AM", temp: 45, feels: 43, ic: "cloud" },
  { t: "7AM", temp: 48, feels: 46, ic: "cloud-sun" },
  { t: "8AM", temp: 51, feels: 50, ic: "cloud-sun" },
  { t: "9AM", temp: 54, feels: 53, ic: "sun" },
  { t: "10AM", temp: 57, feels: 55, ic: "sun" },
  { t: "11AM", temp: 60, feels: 58, ic: "sun" },
  { t: "12PM", temp: 63, feels: 61, ic: "sun" },
];

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Next 12 Hours/Comfort Band",
  component: Next12HoursModalComfortBand,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    hours: EVENING_HOURS,
    now: { hi: 81, lo: 48, feels: 76 },
  },
} satisfies Meta<typeof Next12HoursModalComfortBand>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Comfort & Layer Advisor , warm afternoon into cold night ─────────────────

export const ComfortAdvisor: Story = {
  name: "Comfort & Layer Advisor , evening drop",
};

// ─── Cold morning , all cool/cold bands, rising swing ─────────────────────────

export const ColdMorning: Story = {
  name: "Cold morning , rising swing, all cool/cold",
  args: {
    hours: COLD_MORNING_HOURS,
    now: { hi: 63, lo: 38, feels: 40 },
  },
};
