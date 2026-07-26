import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { DevOverlayHud } from "./DevOverlayHud";

/**
 * The consolidated developer overlay (#64), gated on the board by the single
 * "Developer overlay" switch on the Device settings page. Its only React Query
 * dependency is useConnectionStatus (watching the cache for a sustained
 * outage), so a plain QueryClient with nothing primed is enough , it never
 * fires a real request.
 */
function Backdrop({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <div
        style={{
          position: "relative",
          width: 1366,
          height: 240,
          background: "var(--bg)",
        }}
      >
        {children}
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: "Components/DevOverlayHud",
  component: DevOverlayHud,
  tags: ["autodocs"],
  parameters: { boardWrapper: false, layout: "fullscreen" },
  decorators: [
    (Story) => (
      <Backdrop>
        <Story />
      </Backdrop>
    ),
  ],
} satisfies Meta<typeof DevOverlayHud>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
