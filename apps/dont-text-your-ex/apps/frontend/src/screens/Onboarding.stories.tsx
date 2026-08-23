import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { AppCtx, RouteFor } from "../appctx";
import type { AppleSignInResponse } from "../native/appleSignIn";
import { Onboarding, type OnboardingServices } from "./Onboarding";

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
    deleteAccount: fn(),
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

function nativeFailureServices(error: unknown): OnboardingServices {
  return {
    isNativePlatform: fn(() => true),
    createAppleSignInAttempt: fn(async () => ({
      request: {
        attemptId: "attempt_story",
        state: "state_story",
        nonce: "hashed_nonce",
      },
      rawNonce: "nonce_123456789012345678901234567890123456789012345678",
    })),
    authorizeAppleSignIn: fn(async (): Promise<AppleSignInResponse> => {
      throw error;
    }),
    signInWithApple: fn(),
  };
}

export const NativeFailureIsRetryable: Story = {
  args: {
    services: nativeFailureServices(
      Object.assign(new Error("native unavailable"), { code: "apple_sign_in_native_failed" }),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Sign in with Apple" }));
    await expect(await canvas.findByText(/Apple sign-in didn’t finish/)).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Try Sign in with Apple again" }),
    ).toBeEnabled();
  },
};

export const NativeCancellationIsQuiet: Story = {
  args: {
    services: nativeFailureServices(
      Object.assign(new Error("cancelled"), { code: "apple_sign_in_cancelled" }),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Sign in with Apple" }));
    await expect(canvas.queryByText(/Apple sign-in didn’t finish/)).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Sign in with Apple" })).toBeEnabled();
  },
};
