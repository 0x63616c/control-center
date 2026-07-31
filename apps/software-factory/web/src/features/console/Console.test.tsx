import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Console } from "@/features/console/Console";

describe("Console", () => {
  it("makes a failed Ticket blocker impossible to mistake for waiting work", () => {
    render(
      <Console
        state={{
          kind: "ready",
          snapshot: {
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
              candidates: [],
              freeSlots: 3,
              writtenAt: "2026-07-31T12:00:00Z",
              ageSeconds: 0,
              stale: false,
            },
            tickets: [
              {
                id: 1,
                title: "Failed upstream",
                state: "failed",
                ready: false,
                createdAt: "2026-07-31T12:00:00Z",
                updatedAt: "2026-07-31T12:00:00Z",
                blockers: [],
              },
              {
                id: 2,
                title: "Blocked downstream",
                state: "open",
                ready: false,
                createdAt: "2026-07-31T12:00:00Z",
                updatedAt: "2026-07-31T12:00:00Z",
                blockers: [
                  {
                    id: 1,
                    title: "Failed upstream",
                    state: "failed",
                    ready: false,
                    createdAt: "2026-07-31T12:00:00Z",
                    updatedAt: "2026-07-31T12:00:00Z",
                  },
                ],
              },
            ],
          },
        }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("will not unblock without human action");
    // Two links now share this accessible name: the blocker note's in-page
    // jump to the blocking Ticket's own row (`#ticket-1`), and that row's own
    // link to its detail view (`#/tickets/1`, #556). Assert the jump link
    // specifically, by its href, rather than assuming there is only one.
    const jumpLink = screen
      .getAllByRole("link", { name: /#1 Failed upstream/ })
      .find((link) => link.getAttribute("href") === "#ticket-1");
    expect(jumpLink).toBeDefined();
  });
});
