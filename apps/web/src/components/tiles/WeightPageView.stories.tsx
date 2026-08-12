/**
 * Stories for WeightPageView — the Trend page body behind the Weight tile
 * (hosted by TileDetailHost). Mounted in a page-sized container matching the
 * host's padded scroll region so the flex-filled chart renders as on-panel.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { modalDocsParameters } from "./__stories__/factory";
import { WeightPageView } from "./WeightPageView";

// 28 daily medians (lb), oldest → newest, starting 2026-06-22.
// Dates roll over the month boundary via Date arithmetic: the previous
// `2026-06-${22 + i}` produced June 31st through June 49th, which parse as
// Invalid Date, so two thirds of the series became NaN x-coordinates and the
// chart rendered no line at all.
const START = new Date("2026-06-22T00:00:00");
const DAILY = [
  186.2, 185.8, 186.0, 185.4, 185.1, 185.5, 184.8, 184.4, 183.9, 183.2, 183.6, 182.8, 183.0, 182.1,
  182.5, 181.9, 182.3, 181.4, 181.7, 180.8, 181.2, 180.6, 181.0, 180.3, 179.9, 180.6, 179.7, 180.1,
].map((lb, i) => {
  const d = new Date(START);
  d.setDate(d.getDate() + i);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { day, lb };
});

const meta = {
  title: "Pages/WeightTrend",
  component: WeightPageView,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{ height: "100vh", background: "var(--bg)", boxSizing: "border-box", padding: 24 }}
      >
        <Story />
      </div>
    ),
  ],
  args: { onRangeChange: fn(), metric: "weight_kg", onMetricChange: fn() },
} satisfies Meta<typeof WeightPageView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  args: {
    status: "populated",
    range: "30d",
    lb: 180.1,
    daily: DAILY,
    low: 179.7,
    high: 186.2,
    average: 182.4,
    change: -6.1,
    windowLabel: "Jun 22 – Today",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("180.1")).toBeInTheDocument();
    expect(canvas.getByText("Low")).toBeInTheDocument();
    expect(canvas.getByText("-6.1 lb")).toBeInTheDocument();
    expect(canvas.getByText("Jun 22 – Today")).toBeInTheDocument();
  },
};

/** One daily point: no line is meaningful, so the chart area explains itself. */
export const SingleDay: Story = {
  args: {
    status: "populated",
    range: "all",
    lb: 160.6,
    daily: [{ day: "2026-07-22", lb: 160.6 }],
    low: 160.2,
    high: 160.9,
    average: 160.6,
    change: 0,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/Not enough data yet/)).toBeInTheDocument();
    // Stats still show — they are real even with one day.
    expect(canvas.getByText("160.2 lb")).toBeInTheDocument();
    expect(canvas.getByText("160.9 lb")).toBeInTheDocument();
  },
};

/** A skipped day must be visibly distinct from consecutive readings. */
export const WithGap: Story = {
  args: {
    status: "populated",
    range: "30d",
    lb: 160.6,
    daily: [
      { day: "2026-07-14", lb: 162.4 },
      { day: "2026-07-15", lb: 162.2 },
      { day: "2026-07-22", lb: 160.6 },
    ],
    low: 160.2,
    high: 162.6,
    average: 161.7,
    change: -1.8,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const solid = canvas.getByTestId("weight-trend-solid");
    const gap = canvas.getByTestId("weight-trend-gap");
    expect(solid).not.toHaveAttribute("stroke-dasharray");
    expect(gap).toHaveAttribute("stroke-dasharray");
    // Curves use cubic segments instead of sharp line commands.
    expect(solid.getAttribute("d")).toContain("C");
    expect(gap.getAttribute("d")).toContain("C");
    // Every measured day is marked; missing days are communicated by the
    // dotted bridge, not by inventing measurements.
    expect(canvas.getAllByTestId("weight-trend-point")).toHaveLength(3);
    // Calendar dates make elapsed time readable from the x-axis itself.
    expect(canvas.getByText("Jul 14")).toBeInTheDocument();
    expect(canvas.getByText("Jul 22")).toBeInTheDocument();
    // Axis label reflects the daily-series max (162.4), not the raw `high`
    // stat (162.6) — the two diverge on purpose once labels stop sitting on
    // the raw low/high figures.
    expect(canvas.getByText("162.4")).toBeInTheDocument();
  },
};

/**
 * A percentage metric. The kg→lb factor must NOT be applied to it, and every
 * number carries "%" rather than "lb" — the regression this story guards.
 */
export const FatRatio: Story = {
  args: {
    status: "populated",
    range: "30d",
    metric: "fat_ratio_percent",
    unit: "%",
    lb: 17.1,
    daily: [
      { day: "2026-07-20", lb: 18.4 },
      { day: "2026-07-21", lb: 17.9 },
      { day: "2026-07-22", lb: 17.1 },
    ],
    low: 17.1,
    high: 18.4,
    average: 17.8,
    change: -1.3,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("17.8%")).toBeInTheDocument();
    expect(canvas.getByText("-1.3%")).toBeInTheDocument();
    // No lb anywhere on a percentage metric.
    expect(canvas.queryByText(/lb/)).not.toBeInTheDocument();
  },
};

export const Loading: Story = {
  args: { status: "loading", range: "30d" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryByText("Low")).not.toBeInTheDocument();
    // The pickers survive every state — you must always be able to switch back.
    expect(canvas.getByRole("radiogroup", { name: "Metric" })).toBeInTheDocument();
  },
};

/**
 * Populated, but this metric has no history (the scale never reported bone
 * mass). Names the metric, and critically KEEPS the picker mounted so you can
 * select your way back out.
 */
export const NoDataForMetric: Story = {
  args: { status: "populated", range: "30d", metric: "bone_mass_kg" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/No bone data yet/)).toBeInTheDocument();
    expect(canvas.queryByText("Low")).not.toBeInTheDocument();
    const picker = canvas.getByRole("radiogroup", { name: "Metric" });
    expect(within(picker).getByRole("radio", { name: "Weight" })).toBeInTheDocument();
  },
};
