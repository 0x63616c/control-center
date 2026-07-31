import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { AxiosResponse } from "axios";
import { describe, expect, it } from "vitest";
import { getListV1TicketsByTicketIdRunsByRunIdStagesByStageTurnsByTurnAttemptsByAttemptNoTranscriptQueryKey } from "@/api/generated";
import { TranscriptViewer } from "@/features/ticket-detail/TranscriptViewer";

const TICKET_ID = 42;
const RUN_ID = "019fb6a0-c159-7a3a-9067-eda7a63a8ac7";
const STAGE = "implement";
const TURN = 1;
const ATTEMPT_NO = 1;

function renderViewer(queryClient: QueryClient) {
  render(
    <QueryClientProvider client={queryClient}>
      <TranscriptViewer ticketId={TICKET_ID} runId={RUN_ID} stage={STAGE} turn={TURN} attemptNo={ATTEMPT_NO} />
    </QueryClientProvider>,
  );
}

describe("TranscriptViewer", () => {
  it("starts collapsed behind a View transcript button, fetching nothing yet", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderViewer(queryClient);
    expect(screen.getByRole("button", { name: "View transcript" })).toBeInTheDocument();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("renders the transcript readably once opened, oldest event first", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = getListV1TicketsByTicketIdRunsByRunIdStagesByStageTurnsByTurnAttemptsByAttemptNoTranscriptQueryKey(
      TICKET_ID,
      RUN_ID,
      STAGE,
      TURN,
      ATTEMPT_NO,
    );
    const raw = `${JSON.stringify({ event: "start" })}\n${JSON.stringify({ event: "end" })}\n`;
    queryClient.setQueryData(key, { data: raw, status: 200 } as AxiosResponse<string>);

    renderViewer(queryClient);
    screen.getByRole("button", { name: "View transcript" }).click();

    await waitFor(() => expect(screen.getByTestId("transcript-viewer")).toBeInTheDocument());
    const text = screen.getByTestId("transcript-viewer").textContent ?? "";
    expect(text.indexOf('"start"')).toBeLessThan(text.indexOf('"end"'));
  });

  it("reports an error rather than hanging when the transcript cannot be fetched", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderViewer(queryClient);
    screen.getByRole("button", { name: "View transcript" }).click();

    // No mock server backs this request in a unit test; it fails for real,
    // which is exactly the "no network" case this assertion covers.
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not load transcript"));
  });
});
