import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import { DevOverlayHud } from "../DevOverlayHud";

afterEach(cleanup);

// useConnectionStatus (the HUD's only React Query consumer) needs a
// QueryClient in scope; it never actually fires a network request in this
// test, it just watches the cache for a sustained outage.
function renderHud() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DevOverlayHud />
    </QueryClientProvider>,
  );
}

describe("DevOverlayHud", () => {
  it("renders the consolidated FPS/build/connection/device readouts", () => {
    renderHud();
    // No vite `define` in the test env, so BUILD_HASH falls back to "dev".
    expect(screen.getByText("FPS")).toBeInTheDocument();
    expect(screen.getByText("#dev")).toBeInTheDocument();
    expect(screen.getByText("Link")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Device")).toBeInTheDocument();
  });

  it("omits the app-build stat off-device (getInstalledBuildNumber resolves null in jsdom)", () => {
    renderHud();
    expect(screen.queryByText("App build")).not.toBeInTheDocument();
  });
});
