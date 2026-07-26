/**
 * Stories for ExpandedNotificationCenterView , the Notification Center
 * detail page body. View-driven (all data + callbacks via props, including
 * "now", so the relative ages are deterministic). Grouped under "Modals/" , the
 * component is a bare page body now (hosted by TileDetailHost in the app), so
 * stories mount it inside a plain page-sized container matching the host's
 * content region.
 */

import { ExpandedNotificationCenterView } from "@features/notif/web";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { NotificationItem } from "@/lib/notifications";
import { modalDocsParameters, pageHostDecorator } from "../__stories__/factory";

// A fixed "now" so every age label in these stories is stable.
const NOW = Date.parse("2026-07-18T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const items: NotificationItem[] = [
  {
    id: "notif_ci",
    createdAt: minutesAgo(3),
    category: "ci",
    severity: "critical",
    title: "Deploy failed on main",
    body: "control-center-api image build exited 1 during the typecheck step.",
  },
  {
    id: "notif_home",
    createdAt: minutesAgo(21),
    category: "home",
    severity: "warning",
    title: "Front door unlocked for 20 mins",
  },
  {
    id: "notif_media",
    createdAt: minutesAgo(90),
    category: "media",
    severity: "info",
    title: "Playlist import finished",
    body: "412 tracks enriched, 3 skipped.",
    readAt: minutesAgo(80),
  },
];

const meta = {
  title: "Modals/Notifications/Center",
  component: ExpandedNotificationCenterView,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    filter: "unread" as const,
    onFilterChange: fn(),
    items,
    unreadCount: 2,
    nowMs: NOW,
    onMarkRead: fn(),
    onMarkAllRead: fn(),
  },
} satisfies Meta<typeof ExpandedNotificationCenterView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unread: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.getByText("2 unread")).toBeInTheDocument();
    await expect(canvas.getByText("Deploy failed on main")).toBeInTheDocument();
    await expect(canvas.getByText("CI")).toBeInTheDocument();
    // The read row loses "Mark read"; only the two unread rows keep it.
    await expect(canvas.getAllByRole("button", { name: "Mark read" })).toHaveLength(2);
  },
};

/** Per-row actions route out through the callbacks, not internal state. */
export const RowActions: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getAllByRole("button", { name: "Mark read" })[0]);
    await expect(args.onMarkRead).toHaveBeenCalledWith("notif_ci");
    await userEvent.click(canvas.getByRole("button", { name: "Mark all read" }));
    await expect(args.onMarkAllRead).toHaveBeenCalled();
  },
};

export const TabSwitch: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole("radio", { name: "All" }));
    await expect(args.onFilterChange).toHaveBeenCalledWith("all");
  },
};

export const Loading: Story = {
  args: { loading: true, items: [], unreadCount: 0 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.queryByText("All caught up")).not.toBeInTheDocument();
    // Mark-all-read is inert with nothing unread.
    await expect(canvas.getByRole("button", { name: "Mark all read" })).toBeDisabled();
  },
};

export const ErrorState: Story = {
  args: { items: [], unreadCount: 0, error: "The API is unreachable." },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.getByText("Couldn't load notifications")).toBeInTheDocument();
    await expect(canvas.getByText("The API is unreachable.")).toBeInTheDocument();
  },
};

export const EmptyUnread: Story = {
  args: { items: [], unreadCount: 0 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.getByText("All caught up")).toBeInTheDocument();
  },
};

export const EmptyAll: Story = {
  args: { filter: "all" as const, items: [], unreadCount: 0 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.getByText("No notifications yet")).toBeInTheDocument();
  },
};

/** The All tab: read rows recede and offer no further actions. */
export const AllTab: Story = {
  args: {
    filter: "all" as const,
    unreadCount: 0,
    items: [
      {
        id: "notif_old",
        createdAt: minutesAgo(60 * 30),
        category: "system",
        severity: "info",
        title: "Panel restarted after an update",
        readAt: minutesAgo(60 * 20),
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.getByText("Panel restarted after an update")).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Mark read" })).not.toBeInTheDocument();
  },
};
