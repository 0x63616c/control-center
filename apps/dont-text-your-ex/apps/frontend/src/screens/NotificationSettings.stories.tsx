import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { AppCtx, RouteFor } from "../appctx";
import { NotificationSettings, type NotificationSettingsServices } from "./NotificationSettings";

const ctx = {
  me: null,
  setMe: fn(),
  route: { name: "notificationSettings" },
  nav: fn(),
  back: fn(),
  tab: fn(),
  signIn: fn(),
  signOut: fn(),
  deleteAccount: fn(),
  sessionExpired: false,
  fireBurst: fn(),
  hasPendingReport: false,
  refreshPending: fn(),
} satisfies AppCtx<RouteFor<"notificationSettings">>;

const updatePreferences = fn<NotificationSettingsServices["updatePreferences"]>();
const services: NotificationSettingsServices = {
  preferences: fn(async () => ({
    report: true,
    rescue: true,
    slip: false,
    join: false,
    jar_milestone: false,
    streak_milestone: false,
    recap: false,
    invite: false,
    account_deletion: false,
  })),
  updatePreferences,
  enable: fn(async () => ({ ok: true })),
  disable: fn(async () => undefined),
};

const meta = {
  title: "Don't Text Your Ex/Flows/Notification Settings",
  component: NotificationSettings,
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
} satisfies Meta<typeof NotificationSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PrivacySafeDefaults: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Private by design")).resolves.toBeVisible();
    await expect(canvas.getByRole("switch", { name: "Reports" })).toBeChecked();
    await expect(canvas.getByRole("switch", { name: "Slips" })).not.toBeChecked();
    updatePreferences.mockResolvedValueOnce({
      report: true,
      rescue: true,
      slip: true,
      join: false,
      jar_milestone: false,
      streak_milestone: false,
      recap: false,
      invite: false,
      account_deletion: false,
    });
    await userEvent.click(canvas.getByRole("switch", { name: "Slips" }));
    await expect(updatePreferences).toHaveBeenCalledWith({ slip: true });
  },
};
