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
    expect(screen.getByRole("link", { name: /Ticket 1: Failed upstream/ })).toHaveAttribute(
      "href",
      "#ticket-1",
    );
  });
});
