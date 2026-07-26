/**
 * Stories for the data-backed Settings pages (Network, Notifications). Same
 * 720px column frame as SettingsPages.stories so each page reads the way it
 * does inside the full-page shell.
 *
 * #64: Debug and About folded into Device (see SettingsPages.stories.tsx's
 * `Device` story, which now covers the merged Build/Developer/Danger-zone
 * sections that used to live here).
 *
 * Network reads tRPC; there is no global trpc provider in Storybook, so
 * `TrpcHarness` stands up a throwaway QueryClient + trpc provider and primes the
 * exact query keys with fixtures. The fixtures live ONLY here , the shipped
 * pages render whatever the real queries return (Skeleton / "unavailable"
 * otherwise), never these values.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { getQueryKey } from "@trpc/react-query";
import { useEffect, useState } from "react";
import { expect, within } from "storybook/test";
import { trpc } from "../../../lib/trpc";
import { useNotifications } from "../../../lib/useNotifications";
import { NetworkPage } from "./NetworkPage";
import { NotificationsPage } from "./NotificationsPage";

function ColumnFrame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 40, background: "var(--bg)", minHeight: "100vh" }}>
      <div
        style={{
          width: 720,
          margin: "0 auto",
          color: "var(--ink)",
          fontFamily: "var(--ui)",
          display: "flex",
          flexDirection: "column",
          gap: 28,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Provides a trpc + QueryClient context whose cache is pre-primed by `prime`.
 * The client's fetch never resolves , with fresh primed data and no refetch,
 * nothing hits it; it exists only so an unprimed query can't error the story.
 */
function TrpcHarness({
  prime,
  children,
}: {
  prime: (qc: QueryClient) => void;
  children: React.ReactNode;
}) {
  const [queryClient] = useState(() => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: Number.POSITIVE_INFINITY,
          gcTime: Number.POSITIVE_INFINITY,
          retry: false,
          refetchOnMount: false,
          refetchOnWindowFocus: false,
        },
      },
    });
    prime(qc);
    return qc;
  });
  const [client] = useState(() =>
    trpc.createClient({
      links: [httpBatchLink({ url: "/trpc", fetch: () => new Promise<Response>(() => {}) })],
    }),
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/Settings/Data Pages",
  tags: ["autodocs"],
  parameters: { boardWrapper: false, layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Network ──────────────────────────────────────────────────────────────────

const NETWORK_FIXTURE = {
  status: "Online" as const,
  ssid: "Homelab-5G",
  down: "18.4",
  up: "4.2",
  ping: 12,
  traffic: [] as Array<{ down: number; up: number }>,
};

export const Network: Story = {
  render: () => (
    <TrpcHarness
      prime={(qc) => {
        qc.setQueryData(getQueryKey(trpc.network.status, undefined, "query"), NETWORK_FIXTURE);
      }}
    >
      <ColumnFrame>
        <NetworkPage />
      </ColumnFrame>
    </TrpcHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Homelab-5G")).toBeInTheDocument();
    await expect(canvas.getByText("Online")).toBeInTheDocument();
    await expect(canvas.getByText("12 ms")).toBeInTheDocument();
    await expect(canvas.getByText("18.4 GB")).toBeInTheDocument();
    await expect(canvas.getByText("Browser online")).toBeInTheDocument();
  },
};

// ─── Notifications ────────────────────────────────────────────────────────────

// The page's push section registers an APNs token through tRPC, so it needs the
// harness too , nothing is primed because a mutation has no cache entry to seed
// (and the story never fires it; push is unsupported off the native shell).
export const NotificationsEmpty: Story = {
  render: () => (
    <TrpcHarness prime={() => {}}>
      <ColumnFrame>
        <NotificationsPage />
      </ColumnFrame>
    </TrpcHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No active notifications")).toBeInTheDocument();
  },
};

/** Seeds a couple of live notifications for the lifetime of the story, then
 *  clears them on unmount so the module-level store doesn't leak across stories. */
function SeedNotifications() {
  const { raiseNotification, clearNotification } = useNotifications();
  useEffect(() => {
    const ids = ["settings_story_wan", "settings_story_update"];
    raiseNotification({
      id: ids[0],
      message: "WAN offline",
      detail: "The router lost its internet uplink.",
    });
    raiseNotification({
      id: ids[1],
      message: "Update available",
      detail: "A newer TestFlight build is ready to install.",
    });
    return () => {
      for (const id of ids) clearNotification(id);
    };
  }, [raiseNotification, clearNotification]);
  return <NotificationsPage />;
}

export const NotificationsActive: Story = {
  render: () => (
    <TrpcHarness prime={() => {}}>
      <ColumnFrame>
        <SeedNotifications />
      </ColumnFrame>
    </TrpcHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("WAN offline")).toBeInTheDocument();
    await expect(canvas.getByText("Update available")).toBeInTheDocument();
    await expect(canvas.getAllByRole("button", { name: "Dismiss" })).toHaveLength(2);
  },
};
