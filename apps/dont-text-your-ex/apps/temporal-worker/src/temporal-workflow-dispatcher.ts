import { type Client, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { DomainEvent, DomainEventType } from "../../api/src/domain-events";
import type { WorkflowDispatcher, WorkflowDispatchResult } from "../../api/src/workflow-dispatcher";

type WorkflowType =
  | "InviteLifecycleWorkflow"
  | "ReportAccountabilityWorkflow"
  | "UrgeRescueWorkflow"
  | "NotificationDeliveryWorkflow"
  | "AccountDeletionWorkflow";

type WorkflowArgument = Readonly<{
  aggregateId: string;
  aggregateVersion: number;
  schemaVersion: 1;
}>;

export type TemporalOperation =
  | Readonly<{
      kind: "start";
      workflowType: WorkflowType;
      workflowId: string;
      args: WorkflowArgument;
    }>
  | Readonly<{
      kind: "signal_with_start";
      workflowType: WorkflowType;
      workflowId: string;
      signal: string;
      args: WorkflowArgument;
    }>
  | Readonly<{ kind: "fanout" }>
  | Readonly<{ kind: "audit" }>;

const argument = (event: DomainEvent): WorkflowArgument => ({
  aggregateId: event.aggregateId,
  aggregateVersion: event.aggregateVersion,
  schemaVersion: 1,
});

export function temporalOperationFor(event: DomainEvent): TemporalOperation {
  const args = argument(event);
  switch (event.type) {
    case "jar.created":
    case "rescue.abandoned":
      return { kind: "audit" };
    case "invite.issued":
      return {
        kind: "start",
        workflowType: "InviteLifecycleWorkflow",
        workflowId: `invite/${event.aggregateId}`,
        args,
      };
    case "invite.superseded":
      return {
        kind: "signal_with_start",
        workflowType: "InviteLifecycleWorkflow",
        workflowId: `invite/${event.aggregateId}`,
        signal: "superseded",
        args,
      };
    case "report.created":
      return {
        kind: "start",
        workflowType: "ReportAccountabilityWorkflow",
        workflowId: `report/${event.aggregateId}`,
        args,
      };
    case "report.owned":
    case "report.denied":
      return {
        kind: "signal_with_start",
        workflowType: "ReportAccountabilityWorkflow",
        workflowId: `report/${event.aggregateId}`,
        signal: event.type === "report.owned" ? "owned" : "denied",
        args,
      };
    case "rescue.started":
      return {
        kind: "start",
        workflowType: "UrgeRescueWorkflow",
        workflowId: `rescue/${event.aggregateId}`,
        args,
      };
    case "rescue.extended":
    case "rescue.safe":
    case "rescue.slipped":
      return {
        kind: "signal_with_start",
        workflowType: "UrgeRescueWorkflow",
        workflowId: `rescue/${event.aggregateId}`,
        signal:
          event.type === "rescue.extended"
            ? "extend"
            : event.type === "rescue.safe"
              ? "safe"
              : "slipped",
        args,
      };
    case "notification.requested":
      return {
        kind: "start",
        workflowType: "NotificationDeliveryWorkflow",
        workflowId: `notification/${event.aggregateId}`,
        args,
      };
    case "account.deletion_requested":
      return {
        kind: "start",
        workflowType: "AccountDeletionWorkflow",
        workflowId: `deletion/${event.aggregateId}`,
        args,
      };
    case "jar.closed":
    case "membership.joined":
    case "membership.left":
    case "slip.logged":
    case "jar.milestone_crossed":
    case "report.expired":
    case "rescue.check_in_due":
    case "streak.milestone_reached":
    case "recap.created":
      return { kind: "fanout" };
  }
}

interface TemporalEventHandler {
  handle(operation: TemporalOperation, event: DomainEvent): Promise<void>;
}

export interface TemporalWorkflowGateway {
  execute(operation: Exclude<TemporalOperation, { kind: "audit" | "fanout" }>): Promise<void>;
}

export class TemporalClientWorkflowGateway implements TemporalWorkflowGateway {
  constructor(private readonly client: Client) {}
  async execute(
    operation: Exclude<TemporalOperation, { kind: "audit" | "fanout" }>,
  ): Promise<void> {
    if (operation.kind === "signal_with_start") {
      await this.client.workflow.signalWithStart(operation.workflowType, {
        workflowId: operation.workflowId,
        taskQueue: "main",
        args: [operation.args],
        signal: operation.signal,
        signalArgs: [operation.args],
      });
      return;
    }
    try {
      await this.client.workflow.start(operation.workflowType, {
        workflowId: operation.workflowId,
        taskQueue: "main",
        args: [operation.args],
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
  }
}

class GatewayTemporalEventHandler implements TemporalEventHandler {
  constructor(private readonly gateway: TemporalWorkflowGateway) {}
  async handle(operation: TemporalOperation): Promise<void> {
    if (operation.kind === "audit" || operation.kind === "fanout") {
      throw new Error("operation requires a domain resolver");
    }
    await this.gateway.execute(operation);
  }
}

const DIRECT_EVENTS_BY_WORKFLOW = {
  InviteLifecycleWorkflow: ["invite.issued", "invite.superseded"],
  ReportAccountabilityWorkflow: ["report.created", "report.owned", "report.denied"],
  UrgeRescueWorkflow: ["rescue.started", "rescue.extended", "rescue.safe", "rescue.slipped"],
  NotificationDeliveryWorkflow: ["notification.requested"],
  AccountDeletionWorkflow: ["account.deletion_requested"],
} as const satisfies Record<WorkflowType, readonly DomainEventType[]>;

export function registeredTemporalEventHandlers(
  gateway: TemporalWorkflowGateway,
  workflowTypes: readonly string[],
): HandlerRegistry {
  const handlers: HandlerRegistry = {};
  const handler = new GatewayTemporalEventHandler(gateway);
  for (const [workflowType, eventTypes] of Object.entries(DIRECT_EVENTS_BY_WORKFLOW)) {
    if (!workflowTypes.includes(workflowType)) continue;
    for (const eventType of eventTypes) handlers[eventType] = handler;
  }
  return handlers;
}

export class RecordingTemporalEventHandler implements TemporalEventHandler {
  readonly #operations: TemporalOperation[] = [];
  async handle(operation: TemporalOperation): Promise<void> {
    this.#operations.push(operation);
  }
  operations(): readonly TemporalOperation[] {
    return [...this.#operations];
  }
}

type HandlerRegistry = Partial<Record<DomainEventType, TemporalEventHandler>>;
const AUDIT_EVENT_TYPES = ["jar.created"] as const;

export class TemporalWorkflowDispatcher implements WorkflowDispatcher {
  constructor(private readonly handlers: HandlerRegistry = {}) {}

  supportedEventTypes(): readonly DomainEventType[] {
    return [...AUDIT_EVENT_TYPES, ...(Object.keys(this.handlers) as DomainEventType[])];
  }

  async dispatch(event: DomainEvent): Promise<WorkflowDispatchResult> {
    const operation = temporalOperationFor(event);
    if (operation.kind === "audit") return { status: "accepted" };
    const handler = this.handlers[event.type];
    if (!handler) return { status: "permanent", code: "capability_not_registered" };
    try {
      await handler.handle(operation, event);
      return { status: "accepted" };
    } catch {
      return { status: "retryable", code: "temporal_unavailable" };
    }
  }
}
