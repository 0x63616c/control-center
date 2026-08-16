import type { DomainEvent } from "./domain-events";

export type WorkflowDispatchResult =
  | { readonly status: "accepted" }
  | { readonly status: "retryable"; readonly code: string }
  | { readonly status: "permanent"; readonly code: string };

export interface WorkflowDispatcher {
  dispatch(event: DomainEvent): Promise<WorkflowDispatchResult>;
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
