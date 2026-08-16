import type { DomainEvent, DomainEventType } from "./domain-events";
import type { Outbox, OutboxFailureCode } from "./outbox";
export type WorkflowDispatchResult =
  | { readonly status: "accepted" }
  | { readonly status: "retryable"; readonly code: OutboxFailureCode }
  | { readonly status: "permanent"; readonly code: OutboxFailureCode };

export interface WorkflowDispatcher {
  supportedEventTypes(): readonly DomainEventType[];
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
  eventIds?: readonly DomainEvent["id"][];
  onAccepted?: (observation: Readonly<{ latencySeconds: number }>) => void;
}>;

export async function dispatchOutboxPage(input: DispatchOutboxPageInput): Promise<{
  readonly claimed: number;
  readonly accepted: number;
  readonly retried: number;
  readonly failed: number;
}> {
  const events = await input.outbox.claimPage({
    ...input,
    eventTypes: input.dispatcher.supportedEventTypes(),
  });
  let accepted = 0;
  let retried = 0;
  let failed = 0;
  for (const event of events) {
    let result: WorkflowDispatchResult;
    try {
      result = await input.dispatcher.dispatch(event);
    } catch {
      result = { status: "retryable", code: "dispatch_unexpected" };
    }
    switch (result.status) {
      case "accepted":
        if (
          await input.outbox.markAccepted({ eventId: event.id, owner: input.owner, at: input.now })
        ) {
          accepted += 1;
          input.onAccepted?.({ latencySeconds: Math.max(0, input.now - event.occurredAt) / 1000 });
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
  readonly #supportedEventTypes: readonly DomainEventType[];

  constructor(
    outcomes: readonly WorkflowDispatchResult[] = [],
    supportedEventTypes: readonly DomainEventType[] = [
      "jar.created",
      "jar.closed",
      "invite.issued",
      "invite.superseded",
      "membership.joined",
      "membership.left",
      "slip.logged",
      "jar.milestone_crossed",
      "report.created",
      "report.owned",
      "report.denied",
      "report.expired",
      "rescue.started",
      "rescue.extended",
      "rescue.safe",
      "rescue.slipped",
      "rescue.check_in_due",
      "rescue.abandoned",
      "streak.milestone_reached",
      "recap.created",
      "notification.requested",
      "account.deletion_requested",
    ],
  ) {
    this.#outcomes = [...outcomes];
    this.#supportedEventTypes = [...supportedEventTypes];
  }

  supportedEventTypes(): readonly DomainEventType[] {
    return [...this.#supportedEventTypes];
  }

  async dispatch(event: DomainEvent): Promise<WorkflowDispatchResult> {
    this.#events.push(event);
    return this.#outcomes.shift() ?? { status: "accepted" };
  }

  events(): readonly DomainEvent[] {
    return [...this.#events];
  }
}
