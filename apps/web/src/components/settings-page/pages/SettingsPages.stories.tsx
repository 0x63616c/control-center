import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { getQueryKey } from "@trpc/react-query";
import { useState } from "react";
import { expect, fn, within } from "storybook/test";
import { trpc } from "../../../lib/trpc";
import type { PageProps } from "../SettingsPage";
import { BoardPage } from "./BoardPage";
import { DevicePage } from "./DevicePage";
import { DisplayPage } from "./DisplayPage";

/**
 * Device now reads `trpc.health.buildHash` (folded in from About, #64), so its
 * story needs the same throwaway trpc harness SettingsDataPages.stories.tsx
 * uses , primed here rather than shared so this file stays self-contained.
 */
function TrpcHarness({ children }: { children: React.ReactNode }) {
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
    qc.setQueryData(getQueryKey(trpc.health.buildHash, undefined, "query"), {
      hash: "abc1234deadbeef",
      deployedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
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

// The real pages live inside the full-page Settings content column (720px, on
// var(--bg)); this frame reproduces that footprint so each page reads the way it
// does in the shell. Pages read/write the shared settings store, so every
// control here is live.
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

const pageProps: PageProps = { onClose: fn(), onOpenLevel: fn(), onOpenClean: fn() };

const meta = {
  title: "Pages/Settings/Pages",
  tags: ["autodocs"],
  parameters: { boardWrapper: false, layout: "fullscreen" },
  decorators: [
    (Story) => (
      <ColumnFrame>
        <Story />
      </ColumnFrame>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Device: Story = {
  render: () => (
    <TrpcHarness>
      <DevicePage {...pageProps} />
    </TrpcHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("textbox", { name: "Device name" })).toBeInTheDocument();
    await expect(canvas.getByText("Battery")).toBeInTheDocument();
    await expect(canvas.getByText("Level")).toBeInTheDocument();
    await expect(canvas.getByText("Device ID")).toBeInTheDocument();
    // Folded in from About (#64): build provenance.
    await expect(canvas.getByText("Web")).toBeInTheDocument();
    await expect(canvas.getByText("Server")).toBeInTheDocument();
    await expect(canvas.getByText("App build")).toBeInTheDocument();
    await expect(canvas.getByText("1366×1024")).toBeInTheDocument();
    // Server SHA is shortened to 7 chars with a relative age appended.
    await expect(canvas.getByText(/abc1234 · /)).toBeInTheDocument();
    // Folded in from Debug (#64): one developer-overlay switch, no more
    // separate FPS/build-badge/build-number switches.
    await expect(canvas.getByRole("switch", { name: "Developer overlay" })).toBeInTheDocument();
    // Reset is guarded: tapping it opens a confirmation dialog (the Modal
    // portals to document.body) rather than resetting immediately.
    const doc = within(canvasElement.ownerDocument.body);
    canvas.getByRole("button", { name: "Reset" }).click();
    await expect(await doc.findByText("Reset settings?")).toBeInTheDocument();
  },
};

export const Display: Story = {
  render: () => <DisplayPage {...pageProps} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("slider", { name: "Brightness" })).toBeInTheDocument();
    await expect(canvas.getByRole("switch", { name: "Dim when idle" })).toBeInTheDocument();
    // Idle dimming defaults on, so both sub-sliders render.
    await expect(canvas.getByRole("slider", { name: "Dim after" })).toBeInTheDocument();
    await expect(canvas.getByRole("slider", { name: "Dim level" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Start" })).toBeInTheDocument();
  },
};

export const Board: Story = {
  render: () => <BoardPage {...pageProps} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("switch", { name: "Minimap" })).toBeInTheDocument();
    await expect(canvas.getByText("Board snap")).toBeInTheDocument();
  },
};
