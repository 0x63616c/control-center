import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { AppCtx, RouteFor } from "../appctx";
import { Onboarding } from "./Onboarding";

function onboardingContext(sessionExpired: boolean): AppCtx<RouteFor<"onboarding">> {
  return {
    me: null,
    setMe: fn(),
    route: { name: "onboarding" },
    nav: fn(),
    back: fn(),
    tab: fn(),
    signIn: fn(),
    signOut: fn(),
    sessionExpired,
    fireBurst: fn(),
    hasPendingReport: false,
    refreshPending: fn(),
  };
}

const meta = {
  title: "Don't Text Your Ex/Flows/Onboarding",
  component: Onboarding,
  tags: ["autodocs"],
  parameters: { boardWrapper: false, layout: "centered" },
  decorators: [
    (Story) => (
      <div style={{ width: 390, height: 844, overflow: "hidden", background: "#000" }}>
        <Story />
      </div>
    ),
  ],
  args: { ctx: onboardingContext(false) },
} satisfies Meta<typeof Onboarding>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FirstVisit: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading")).toHaveTextContent(/Don't\s*Text\s*Your Ex\./);
    await expect(canvas.getByRole("button", { name: "Sign in with Apple" })).toBeEnabled();
  },
};

export const ExpiredSession: Story = {
  args: { ctx: onboardingContext(true) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading")).toHaveTextContent(/Still\s*Texting\s*Them\?/);
    await expect(canvas.getByRole("button", { name: "Continue with Apple" })).toBeEnabled();
  },
};
