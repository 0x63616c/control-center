import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";

// Only the transport is a test double. Everything above it , the generated
// hook, the query wiring, the App component , is the real production chain
// (#553 acceptance 4: Go type -> OpenAPI -> Orval -> React, no hand-written
// fetch, no fixture endpoint of our own).
vi.mock("axios");

function renderWithClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("App", () => {
  it("renders the dispatcher snapshot returned by the generated client", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: {
        factory: {
          paused: false,
          pauseReason: "",
          maxInFlight: 3,
          configError: "",
          breakerOpen: false,
          breakerReason: "",
          breakerOpenUntil: "0001-01-01T00:00:00Z",
        },
        dispatcher: {
          inFlight: [],
          candidates: [555],
          freeSlots: 2,
          writtenAt: "2026-07-31T12:00:00Z",
          ageSeconds: 0,
          stale: false,
        },
        tickets: [],
      },
    });

    renderWithClient();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Next" })).toBeInTheDocument();
    });
    expect(axios.get).toHaveBeenCalledWith("/v1/console", expect.anything());
  });

  it("shows an honest error instead of fake data when the API is unreachable", async () => {
    vi.mocked(axios.get).mockRejectedValueOnce(new Error("Network Error"));

    renderWithClient();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Network Error");
    });
  });
});
