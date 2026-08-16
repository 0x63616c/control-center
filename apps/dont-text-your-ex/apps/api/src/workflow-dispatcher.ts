import type { DomainEvent } from "./domain-events";
import type { Outbox } from "./outbox";

export type WorkflowDispatchResult =
  | { readonly status: "accepted" }
  | { readonly status: "retryable"; readonly code: string }
  | { readonly status: "permanent"; readonly code: string };

interface WorkflowDispatcher {
  dispatch(event: DomainEvent): Promise<WorkflowDispatchResult>;
}

type DispatchOutboxPageInput = Readonly<{
  outbox: Outbox;
  dispatcher: WorkflowDispatcher;
  owner: string;
  limit: number;
  now: number;
  leaseUntil: number;
  retryAt: number;
}>;

export async function dispatchOutboxPage(input: DispatchOutboxPageInput): Promise<{
  readonly claimed: number;
  readonly accepted: number;
  readonly retried: number;
  readonly failed: number;
}> {
  const events = await input.outbox.claimPage(input);
  let accepted = 0;
  let retried = 0;
  let failed = 0;
  for (const event of events) {
    const result = await input.dispatcher.dispatch(event);
    switch (result.status) {
      case "accepted":
        if (
          await input.outbox.markAccepted({ eventId: event.id, owner: input.owner, at: input.now })
        ) {
          accepted += 1;
        }
        break;
      case "retryable":
        {
          const rescheduled = await input.outbox.reschedule({
            eventId: event.id,
            owner: input.owner,
            at: input.now,
            availableAt: input.retryAt,
            code: result.code,
          });
          if (rescheduled.status === "rescheduled") {
            retried += 1;
          } else if (rescheduled.status === "failed") {
            failed += 1;
          }
        }
        break;
      case "permanent":
        if (
          await input.outbox.markFailed({
            eventId: event.id,
            owner: input.owner,
            at: input.now,
            code: result.code,
          })
        ) {
          failed += 1;
        }
        break;
    }
  }
  return { claimed: events.length, accepted, retried, failed };
}

export class RecordingWorkflowDispatcher implements WorkflowDispatcher {
  readonly #events: DomainEvent[] = [];
  readonly #outcomes: WorkflowDispatchResult[];

  constructor(outcomes: readonly WorkflowDispatchResult[] = []) {
    this.#outcomes = [...outcomes];
  }

  async dispatch(event: DomainEvent): Promise<WorkflowDispatchResult> {
    this.#events.push(event);
    return this.#outcomes.shift() ?? { status: "accepted" };
  }

  events(): readonly DomainEvent[] {
    return [...this.#events];
  }
}
