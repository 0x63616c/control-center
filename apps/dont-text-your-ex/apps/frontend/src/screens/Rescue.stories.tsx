import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { AppCtx, RouteFor } from "../appctx";
import { Rescue, type RescueServices } from "./Rescue";

function context(): AppCtx<RouteFor<"rescue">> {
  return {
    me: null,
    setMe: fn(),
    route: { name: "rescue" },
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

const meta = {
  title: "Don't Text Your Ex/Flows/Don't Send It",
  component: Rescue,
  tags: ["autodocs"],
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
    services: {
      currentRescue: fn(() => never<Awaited<ReturnType<RescueServices["currentRescue"]>>>()),
      startRescue: fn(),
      rescueCommand: fn(),
      jars: fn(),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "Checking for an active rescue",
    );
  },
};
