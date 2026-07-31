import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  fixtureAttempt,
  fixtureRun,
  fixtureStep,
  fixtureTicket,
  fixtureUnmeasuredAttempt,
} from "@/features/ticket-detail/fixtures";
import { TicketDetail } from "@/features/ticket-detail/TicketDetail";

const meta = {
  title: "TicketDetail/TicketDetail",
  component: TicketDetail,
  tags: ["autodocs"],
} satisfies Meta<typeof TicketDetail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  args: { state: { kind: "loading" } },
};

export const ErrorState: Story = {
  args: { state: { kind: "error", message: "Network Error" } },
};

// #556 acceptance: "a single-turn run" — one Step, one Attempt, quiet
// rendering (no attempt count badge).
export const SingleTurnRun: Story = {
  args: {
    state: {
      kind: "ready",
      ticket: fixtureTicket(),
      runs: [fixtureRun()],
    },
  },
};

// #556 acceptance: "a multi-turn run" — several Steps of the looping stages,
// each turn its own headline.
export const MultiTurnRun: Story = {
  args: {
    state: {
      kind: "ready",
      ticket: fixtureTicket(),
      runs: [
        fixtureRun({
          steps: [
            fixtureStep({ stage: "plan", turn: 1 }),
            fixtureStep({ stage: "implement", turn: 1 }),
            fixtureStep({
              stage: "implement",
              turn: 2,
              attempts: [
                fixtureAttempt({
                  attemptNo: 1,
                  startedAt: "2026-07-31T11:00:00Z",
                  endedAt: "2026-07-31T11:32:00Z",
                }),
              ],
            }),
            fixtureStep({ stage: "review", turn: 1 }),
          ],
        }),
      ],
    },
  },
};

// #556 acceptance: "a Step with several Attempts" — the machine-retry case,
// where the attempt count badge earns its keep.
export const StepWithSeveralAttempts: Story = {
  args: {
    state: {
      kind: "ready",
      ticket: fixtureTicket(),
      runs: [
        fixtureRun({
          steps: [
            fixtureStep({
              attempts: [
                fixtureAttempt({ attemptNo: 1, result: "failed", endedAt: "2026-07-31T10:05:00Z" }),
                fixtureAttempt({
                  attemptNo: 2,
                  startedAt: "2026-07-31T10:05:00Z",
                  endedAt: "2026-07-31T10:52:00Z",
                }),
              ],
            }),
          ],
        }),
      ],
    },
  },
};

// #556 acceptance: "an unmeasured Attempt" — a resumed Attempt renders its
// usage as unknown, never zero, and flags the Run incomplete.
export const UnmeasuredAttempt: Story = {
  args: {
    state: {
      kind: "ready",
      ticket: fixtureTicket(),
      runs: [
        fixtureRun({
          steps: [
            fixtureStep({
              attempts: [
                fixtureAttempt({ attemptNo: 1 }),
                fixtureUnmeasuredAttempt({ attemptNo: 2 }),
              ],
            }),
          ],
        }),
      ],
    },
  },
};

// #556 acceptance: "a run with no transcript" — the Attempt says so plainly
// rather than rendering an empty pane.
export const RunWithNoTranscript: Story = {
  args: {
    state: {
      kind: "ready",
      ticket: fixtureTicket(),
      runs: [
        fixtureRun({
          steps: [fixtureStep({ attempts: [fixtureAttempt({ hasTranscript: false })] })],
        }),
      ],
    },
  },
};

// #556 acceptance: "a failed run".
export const FailedRun: Story = {
  args: {
    state: {
      kind: "ready",
      ticket: fixtureTicket({ state: "failed", ready: false }),
      runs: [
        fixtureRun({
          endedAt: "2026-07-31T11:00:00Z",
          outcome: "failed",
          failureKind: "rate-limit",
        }),
      ],
    },
  },
};

// #556 acceptance: "a Ticket with several Runs" — the retry-after-failure
// case, most recent first.
export const TicketWithSeveralRuns: Story = {
  args: {
    state: {
      kind: "ready",
      ticket: fixtureTicket(),
      runs: [
        fixtureRun({ id: "run-2", startedAt: "2026-07-31T12:00:00Z" }),
        fixtureRun({
          id: "run-1",
          startedAt: "2026-07-31T09:00:00Z",
          endedAt: "2026-07-31T09:40:00Z",
          outcome: "failed",
          failureKind: "other",
        }),
      ],
    },
  },
};

// #556 acceptance: dependencies render, linked, with their states.
export const WithDependencies: Story = {
  args: {
    state: {
      kind: "ready",
      ticket: fixtureTicket({
        blockers: [
          {
            id: 40,
            title: "Ticket detail API",
            state: "done",
            ready: false,
            createdAt: "2026-07-25T00:00:00Z",
            updatedAt: "2026-07-29T00:00:00Z",
          },
        ],
        blocks: [
          {
            id: 58,
            title: "Ticket-backed dispatcher",
            state: "open",
            ready: false,
            createdAt: "2026-07-28T00:00:00Z",
            updatedAt: "2026-07-28T00:00:00Z",
          },
        ],
      }),
      runs: [fixtureRun()],
    },
  },
};
