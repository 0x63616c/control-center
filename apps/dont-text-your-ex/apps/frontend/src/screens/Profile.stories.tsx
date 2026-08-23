import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { UserIdSchema } from "../../../../contracts";
import type { AppCtx, RouteFor } from "../appctx";
import type { MeDTO } from "../types";
import { Profile, type ProfileServices } from "./Profile";

const me: MeDTO = {
  id: UserIdSchema.parse("usr_profile"),
  name: "Profile User",
  color: "#FF375F",
  emoji: "🫠",
  photo: null,
  exes: [],
  phone: null,
};

const signOut = fn<() => Promise<void>>();
const deleteAccount = fn<AppCtx["deleteAccount"]>();
const ctx: AppCtx<RouteFor<"profile">> = {
  me,
  setMe: fn(),
  route: { name: "profile" },
  nav: fn(),
  back: fn(),
  tab: fn(),
  signIn: fn(),
  signOut,
  deleteAccount,
  sessionExpired: false,
  fireBurst: fn(),
  hasPendingReport: false,
  refreshPending: fn(),
};

const services: ProfileServices = {
  jars: fn(async () => []),
  setShareStreak: fn(async () => ({ ok: true as const })),
  getNativeAppInfo: fn(async () => null),
  isNativePlatform: fn(() => false),
  createAppleSignInAttempt: fn(),
  authorizeAppleSignIn: fn(),
};

const meta = {
  title: "Don't Text Your Ex/Flows/Profile",
  component: Profile,
  tags: ["autodocs"],
  parameters: { boardWrapper: false, layout: "centered" },
  decorators: [
    (Story) => (
      <div style={{ width: 390, height: 844, overflow: "auto", background: "#000" }}>
        <Story />
      </div>
    ),
  ],
  args: { ctx, services },
} satisfies Meta<typeof Profile>;

export default meta;
type Story = StoryObj<typeof meta>;

export const IdleProfile: Story = {};

export const FailedLogoutCanRetry: Story = {
  play: async ({ canvasElement }) => {
    signOut.mockReset();
    signOut.mockRejectedValueOnce(new Error("network unavailable")).mockResolvedValueOnce();
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole("button", { name: "Sign out" }));
    await expect(canvas.getByRole("alert")).toHaveTextContent(/still signed in/i);
    await expect(canvas.getByRole("button", { name: "Try signing out again" })).toBeEnabled();

    await userEvent.click(canvas.getByRole("button", { name: "Try signing out again" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(2));
  },
};

export const ConfirmedDeletionUsesFreshAppleAuthorization: Story = {
  args: {
    services: {
      ...services,
      isNativePlatform: fn(() => true),
      createAppleSignInAttempt: fn(async () => ({
        request: { attemptId: "attempt_test", state: "state_test", nonce: "hashed_nonce" },
        rawNonce: "raw_nonce",
      })),
      authorizeAppleSignIn: fn(async () => ({
        identityToken: "identity-token",
        authorizationCode: "fresh-authorization-code",
        user: "apple-user",
        attemptId: "attempt_test",
        state: "state_test",
      })),
    },
  },
  play: async ({ canvasElement }) => {
    deleteAccount.mockReset().mockResolvedValueOnce();
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Delete account" }));
    await expect(
      canvas.getByText(/shared jar stays with its earliest active member/i),
    ).toBeVisible();
    const permanentButton = canvas.getByRole("button", {
      name: "Delete my account permanently",
    });
    await expect(permanentButton).toBeDisabled();
    await userEvent.click(canvas.getByRole("checkbox", { name: /cannot be recovered/i }));
    await userEvent.click(permanentButton);
    await waitFor(() =>
      expect(deleteAccount).toHaveBeenCalledWith({
        authorizationCode: "fresh-authorization-code",
        identityToken: "identity-token",
        nonce: "raw_nonce",
      }),
    );
  },
};
