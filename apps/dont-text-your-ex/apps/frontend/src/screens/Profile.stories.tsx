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
const ctx: AppCtx<RouteFor<"profile">> = {
  me,
  setMe: fn(),
  route: { name: "profile" },
  nav: fn(),
  back: fn(),
  tab: fn(),
  signIn: fn(),
  signOut,
  sessionExpired: false,
  fireBurst: fn(),
  hasPendingReport: false,
  refreshPending: fn(),
};

const services: ProfileServices = {
  jars: fn(async () => []),
  setShareStreak: fn(async () => ({ ok: true as const })),
  getNativeAppInfo: fn(async () => null),
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
