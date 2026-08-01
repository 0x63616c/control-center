import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AxiosResponse } from "axios";
import { describe, expect, it } from "vitest";
import { TranscriptViewer, transcriptQueryKey } from "@/features/ticket-detail/TranscriptViewer";

const TRANSCRIPT_PATH =
  "/v1/tickets/42/runs/019fb6a0-c159-7a3a-9067-eda7a63a8ac7/steps/1/attempts/1/transcript";

function renderViewer(queryClient: QueryClient) {
  render(
    <QueryClientProvider client={queryClient}>
      <TranscriptViewer transcriptPath={TRANSCRIPT_PATH} />
    </QueryClientProvider>,
  );
}

describe("TranscriptViewer", () => {
  it("starts collapsed behind a View transcript button, fetching nothing yet", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderViewer(queryClient);
    expect(screen.getByRole("button", { name: "View transcript" })).toBeInTheDocument();
    // `enabled: false` still registers the query in the cache (React Query's
    // own behaviour), so the thing worth asserting is that it never fetched —
    // not that the cache is empty.
    const queries = queryClient.getQueryCache().getAll();
    expect(queries).toHaveLength(1);
    expect(queries[0]?.state.fetchStatus).toBe("idle");
    expect(queries[0]?.state.dataUpdateCount).toBe(0);
  });

  it("renders the transcript readably once opened, oldest event first", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = transcriptQueryKey(TRANSCRIPT_PATH);
    const raw = `${JSON.stringify({ event: "start" })}\n${JSON.stringify({ event: "end" })}\n`;
    queryClient.setQueryData(key, { data: raw, status: 200 } as AxiosResponse<string>);

    renderViewer(queryClient);
    fireEvent.click(screen.getByRole("button", { name: "View transcript" }));

    await waitFor(() => expect(screen.getByTestId("transcript-viewer")).toBeInTheDocument());
    const text = screen.getByTestId("transcript-viewer").textContent ?? "";
    expect(text.indexOf('"start"')).toBeLessThan(text.indexOf('"end"'));
  });

  it("reports an error rather than hanging when the transcript cannot be fetched", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderViewer(queryClient);
    fireEvent.click(screen.getByRole("button", { name: "View transcript" }));

    // No mock server backs this request in a unit test; it fails for real,
    // which is exactly the "no network" case this assertion covers.
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Could not load transcript"),
    );
  });
});
