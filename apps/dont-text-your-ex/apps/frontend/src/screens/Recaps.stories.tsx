import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ApiError } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import type { JarRecapDTO } from "../types";
import { type RecapServices, Recaps } from "./Recaps";

const recap = {
  id: "rcp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  jarId: "jar_recapstory",
  jarName: "Fresh starts",
  calendarMonth: "2026-07",
  timezone: "America/Los_Angeles",
  periodStartAt: 1_751_352_400_000,
  periodEndAt: 1_754_030_800_000,
  slipCount: 2,
  totalAmountCents: 1_000,
  tallyChangeCents: 1_000,
  sharedStreakHighlights: [{ days: 7, count: 2 }],
  crossedMilestonesCents: [1_000],
  createdAt: 1_754_030_801_000,
} as JarRecapDTO;

function context(route: RouteFor<"recaps"> = { name: "recaps" }): AppCtx<RouteFor<"recaps">> {
  return {
    me: null,
    setMe: fn(),
    route,
    nav: fn(),
    back: fn(),
    tab: fn(),
    signIn: fn(),
    signOut: fn(),
    sessionExpired: false,
    fireBurst: fn(),
    hasPendingReport: false,
    refreshPending: fn(),
  };
}

const never = new Promise<JarRecapDTO[]>(() => undefined);
const loadingServices: RecapServices = { recaps: () => never, recap: async () => recap };
const emptyServices: RecapServices = { recaps: async () => [], recap: async () => recap };
const populatedServices: RecapServices = { recaps: async () => [recap], recap: async () => recap };
const unavailableServices: RecapServices = {
  recaps: async () => [],
  recap: async () => Promise.reject(new ApiError(404, "not found")),
};
const offlineServices: RecapServices = {
  recaps: async () => Promise.reject(new Error("offline")),
  recap: async () => Promise.reject(new Error("offline")),
};
let retryCalls = 0;
const retryServices: RecapServices = {
  recaps: async () => {
    retryCalls += 1;
    if (retryCalls === 1) throw new Error("offline");
    return [recap];
  },
  recap: async () => recap,
};

const meta = {
  title: "Don't Text Your Ex/Recaps/States",
  component: Recaps,
  tags: ["autodocs"],
  parameters: { boardWrapper: false, layout: "centered" },
  decorators: [
    (Story) => (
      <div style={{ width: 390, height: 844, overflow: "auto", background: "#000" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Recaps>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  args: { ctx: context(), services: loadingServices },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent("Loading recaps");
  },
};

export const Empty: Story = {
  args: { ctx: context(), services: emptyServices },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole("status")).toHaveTextContent(
      "No recaps yet",
    );
  },
};

export const Populated: Story = {
  args: { ctx: context(), services: populatedServices },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Fresh starts")).toBeVisible();
    await expect(canvas.getByText(/2 × 7 days/)).toBeVisible();
  },
};

export const Unavailable: Story = {
  args: {
    ctx: context({ name: "recaps", recapId: recap.id }),
    services: unavailableServices,
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole("status")).toHaveTextContent(
      "no longer available",
    );
  },
};

export const Offline: Story = {
  args: { ctx: context(), services: offlineServices },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole("alert")).toHaveTextContent(
      "Check your connection",
    );
  },
};

export const Retry: Story = {
  args: { ctx: context(), services: retryServices },
  beforeEach: () => {
    retryCalls = 0;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Retry" }));
    await expect(await canvas.findByText("Fresh starts")).toBeVisible();
  },
};
