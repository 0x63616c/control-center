import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import type React from "react";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { trpc } from "@/lib/trpc";
import { SettingsPage } from "./SettingsPage";

/**
 * The shell renders whichever page is selected, and the Notifications page calls
 * `notifications.registerToken`, so the whole shell needs a trpc context to
 * mount at all. The client's fetch never resolves , nothing in this story
 * depends on a response, it only has to exist so drilling into Notifications
 * doesn't throw "Unable to find tRPC Context".
 */
function TrpcProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
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

// Thin wrapper so Storybook infers props from the function-component signature.
function SettingsPageStory(props: React.ComponentProps<typeof SettingsPage>) {
  return (
    <TrpcProviders>
      <SettingsPage {...props} />
    </TrpcProviders>
  );
}

const meta = {
  title: "Pages/Settings/Settings Page",
  component: SettingsPageStory,
  tags: ["autodocs"],
  parameters: { boardWrapper: false, layout: "fullscreen" },
  args: {
    open: true,
    onClose: fn(),
    onOpenLevel: fn(),
    onOpenClean: fn(),
  },
} satisfies Meta<typeof SettingsPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The full-page settings shell open over the fullscreen frame. Here we assert
 * the sidebar surfaces all eight pages , Debug and About folded into Device
 * (#64), so the count is nine minus two folded-away pages, i.e. eight.
 */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    // The page portals into document.body, so it lives OUTSIDE canvasElement.
    const doc = within(canvasElement.ownerDocument.body);
    for (const name of [
      "Device",
      "Display",
      "Board",
      "Network",
      "Notifications",
      "Security",
      "Logs",
    ]) {
      await expect(doc.getByRole("button", { name })).toBeInTheDocument();
    }
    for (const name of ["Debug", "About"]) {
      expect(doc.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  },
};

/**
 * Escape closes the PIN dialog and leaves Settings open (#298).
 *
 * This is the composed surface, deliberately. Every SecurityPage story mounts
 * that page bare, and the defect this pins only exists when a PIN dialog and
 * the Settings page are open together , which is why a stack of green
 * component stories said nothing about it.
 */
export const EscapeClosesOnlyTheTopSurface: Story = {
  play: async ({ args, canvasElement }) => {
    const doc = within(canvasElement.ownerDocument.body);

    await userEvent.click(doc.getByRole("button", { name: "Security" }));
    await userEvent.click(doc.getByRole("button", { name: "Change PIN" }));
    await expect(doc.getByRole("dialog", { name: "Change PIN" })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    // The dialog goes; Settings stays. `onClose` is the page's only way out of
    // this story, so an untouched spy is what "still open" means here.
    await expect(doc.queryByRole("dialog", { name: "Change PIN" })).not.toBeInTheDocument();
    await expect(doc.getByRole("button", { name: "Change PIN" })).toBeInTheDocument();
    await expect(args.onClose).not.toHaveBeenCalled();

    // A second Escape, with nothing on top, is Settings' own again.
    await userEvent.keyboard("{Escape}");
    await expect(args.onClose).toHaveBeenCalledTimes(1);
  },
};
