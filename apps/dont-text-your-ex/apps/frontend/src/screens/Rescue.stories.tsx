import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  JarSummarySchema,
  type RescueInterventionDTO,
  RescueInterventionSchema,
} from "../../../../contracts";
import { ApiError } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { Rescue, type RescueServices } from "./Rescue";

const NOW = 1_750_000_000_000;
const ID = "rsi_0123456789abcdef0123456789abcdef";

const active = RescueInterventionSchema.parse({
  id: ID,
  status: "active",
  startedAt: NOW,
  deadlineAt: NOW + 10 * 60_000,
  extensionCount: 0,
  aggregateVersion: 1,
  updatedAt: NOW,
});
const extended = RescueInterventionSchema.parse({
  ...active,
  deadlineAt: NOW + 20 * 60_000,
  extensionCount: 1,
  aggregateVersion: 2,
  updatedAt: NOW + 1_000,
});
const safe = RescueInterventionSchema.parse({
  ...active,
  status: "safe",
  aggregateVersion: 2,
  resolvedAt: NOW + 2_000,
  updatedAt: NOW + 2_000,
});
const slipped = RescueInterventionSchema.parse({
  ...active,
  status: "slipped",
  aggregateVersion: 2,
  resolvedAt: NOW + 2_000,
  updatedAt: NOW + 2_000,
});
const abandoned = RescueInterventionSchema.parse({
  ...active,
  status: "abandoned",
  aggregateVersion: 2,
  resolvedAt: NOW + 15 * 60_000,
  updatedAt: NOW + 15 * 60_000,
});
const jar = JarSummarySchema.parse({
  id: "jar_rescuestory",
  name: "No-contact crew",
  rule: "No contact",
  defaultCents: 500,
  memberIds: ["usr_rescuestory"],
  memberCount: 1,
  jarTotalCents: 0,
  myTallyCents: 0,
  myDaysClean: 4,
  myShareStreak: false,
});
const slippedNavigation = fn();

function context(nav = fn()): AppCtx<RouteFor<"rescue">> {
  return {
    me: null,
    setMe: fn(),
    route: { name: "rescue" },
    nav,
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

function servicesFor(
  current: RescueInterventionDTO | null,
  overrides: Partial<RescueServices> = {},
): RescueServices {
  return {
    currentRescue: fn(async () => current),
    startRescue: fn(async () => active),
    rescueCommand: fn(async () => active),
    jars: fn(async () => [jar]),
    ...overrides,
  };
}

const meta = {
  title: "Don't Text Your Ex/Flows/Don't Send It",
  component: Rescue,
  tags: ["autodocs"],
  args: { ctx: context() },
  parameters: { boardWrapper: false, layout: "centered" },
  decorators: [
    (Story) => (
      <div style={{ width: 390, height: 844, overflow: "auto", background: "#000" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Rescue>;

export default meta;
type Story = StoryObj<typeof meta>;

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

export const Loading: Story = {
  args: {
    ctx: context(),
    services: servicesFor(null, {
      currentRescue: fn(() => never<RescueInterventionDTO | null>()),
    }),
    now: () => NOW,
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "Checking for an active rescue",
    );
  },
};

export const ActiveCountdownAndExtend: Story = {
  args: {
    ctx: context(),
    services: servicesFor(active, {
      rescueCommand: fn(async (_id, action) => (action === "extend" ? extended : active)),
    }),
    now: () => NOW,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("timer")).toHaveTextContent("10:00");
    const extend = canvas.getByRole("button", { name: "Give me 10 more minutes (2 left)" });
    await userEvent.pointer([{ target: extend, keys: "[TouchA>]" }, { keys: "[/TouchA]" }]);
    await expect(await canvas.findByRole("timer")).toHaveTextContent("20:00");
    await expect(canvas.getByText("Extended 1 of 2 times")).toBeInTheDocument();
  },
};

export const Safe: Story = {
  args: {
    ctx: context(),
    services: servicesFor(active, { rescueCommand: fn(async () => safe) }),
    now: () => NOW,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = await canvas.findByRole("button", { name: "I’m safe. I didn’t send it." });
    await userEvent.pointer([{ target: button, keys: "[TouchA>]" }, { keys: "[/TouchA]" }]);
    await expect(await canvas.findByText("You made it through.")).toBeInTheDocument();
    await expect(canvas.getByText("That win stays private.")).toBeInTheDocument();
  },
};

export const SlippedOpensExplicitSlipConfirmation: Story = {
  render: () => {
    slippedNavigation.mockClear();
    return (
      <Rescue
        ctx={context(slippedNavigation)}
        services={servicesFor(active, { rescueCommand: fn(async () => slipped) })}
        now={() => NOW}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const slippedButton = await canvas.findByRole("button", { name: "I slipped" });
    await userEvent.pointer([{ target: slippedButton, keys: "[TouchA>]" }, { keys: "[/TouchA]" }]);
    const jarChoice = await canvas.findByRole("button", { name: "Continue to No-contact crew" });
    await expect(canvas.getByText(/normal slip confirmation/)).toBeInTheDocument();
    await userEvent.pointer([{ target: jarChoice, keys: "[TouchA>]" }, { keys: "[/TouchA]" }]);
    await expect(slippedNavigation).toHaveBeenCalledWith({
      name: "logSlip",
      jarId: "jar_rescuestory",
    });
  },
};

export const Abandoned: Story = {
  args: { ctx: context(), services: servicesFor(abandoned), now: () => NOW },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("This rescue ended.")).toBeInTheDocument();
    await expect(canvas.getByText(/Nothing was sent, shared, or charged/)).toBeInTheDocument();
  },
};

export const OfflineThenRetry: Story = {
  render: () => {
    let attempts = 0;
    return (
      <Rescue
        ctx={context()}
        services={servicesFor(null, {
          currentRescue: fn(async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("offline");
            return active;
          }),
        })}
        now={() => NOW}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent("You appear to be offline");
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(await canvas.findByRole("timer")).toHaveTextContent("10:00");
  },
};

export const Unavailable: Story = {
  args: {
    ctx: context(),
    services: servicesFor(null, {
      currentRescue: fn(async () => {
        throw new ApiError(503, "unavailable");
      }),
    }),
    now: () => NOW,
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole("alert")).toHaveTextContent(
      "Rescue is temporarily unavailable",
    );
  },
};

export const DuplicateSubmitAndRecoverableRetry: Story = {
  render: () => {
    let attempts = 0;
    const startRescue = fn(async () => {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (attempts === 1) throw new Error("offline");
      return active;
    });
    return <Rescue ctx={context()} services={servicesFor(null, { startRescue })} now={() => NOW} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const start = await canvas.findByRole("button", { name: "Start 10-minute rescue" });
    await userEvent.dblClick(start);
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Nothing was sent");
    await userEvent.click(canvas.getByRole("button", { name: "Retry starting rescue" }));
    await expect(await canvas.findByRole("timer")).toHaveTextContent("10:00");
  },
};
