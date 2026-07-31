import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Console } from "@/features/console/Console";

describe("Console", () => {
  it("lists Tickets by their recorded state", () => {
    render(
      <Console
        state={{
          kind: "ready",
          snapshot: {
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

    expect(screen.getByRole("link", { name: /Ticket 1: Failed upstream/ })).toHaveAttribute(
      "href",
      "#/tickets/1",
    );
    expect(screen.getByRole("link", { name: /Ticket 2: Blocked downstream/ })).toHaveAttribute(
      "href",
      "#/tickets/2",
    );
  });
});
