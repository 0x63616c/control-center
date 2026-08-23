import {
  type Client,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
} from "@temporalio/client";
import type { DomainEvent, DomainEventType } from "../../api/src/domain-events";
import type { WorkflowDispatcher, WorkflowDispatchResult } from "../../api/src/workflow-dispatcher";
import type { TemporalDispatchFence } from "./workflow-dispatch-fence";

type WorkflowType =
  | "InviteLifecycleWorkflow"
  | "ReportAccountabilityWorkflow"
  | "UrgeRescueWorkflow"
  | "NotificationDeliveryWorkflow"
  | "AccountDeletionWorkflow";

type WorkflowStartArgument =
  | Readonly<{ schemaVersion: 1; inviteVersionId: string }>
  | Readonly<{ schemaVersion: 1; reportId: string }>
  | Readonly<{ schemaVersion: 1; interventionId: string }>
  | Readonly<{ schemaVersion: 1; notificationId: string }>
  | Readonly<{ schemaVersion: 1; deletionRequestId: string }>;
type WorkflowSignalArgument = WorkflowStartArgument &
  Readonly<{ expectedAggregateVersion: number }>;

export type TemporalOperation =
  | Readonly<{
      kind: "start";
      workflowType: WorkflowType;
      workflowId: string;
      args: WorkflowStartArgument;
    }>
  | Readonly<{
      kind: "signal_with_start";
      workflowType: WorkflowType;
      workflowId: string;
      signal: string;
      startArgs: WorkflowStartArgument;
      signalArgs: WorkflowSignalArgument;
    }>
  | Readonly<{ kind: "fanout" }>
  | Readonly<{ kind: "audit" }>;

function startArgument(workflowType: WorkflowType, aggregateId: string): WorkflowStartArgument {
  switch (workflowType) {
    case "InviteLifecycleWorkflow":
      return { schemaVersion: 1, inviteVersionId: aggregateId };
    case "ReportAccountabilityWorkflow":
      return { schemaVersion: 1, reportId: aggregateId };
    case "UrgeRescueWorkflow":
      return { schemaVersion: 1, interventionId: aggregateId };
    case "NotificationDeliveryWorkflow":
      return { schemaVersion: 1, notificationId: aggregateId };
    case "AccountDeletionWorkflow":
      return { schemaVersion: 1, deletionRequestId: aggregateId };
  }
}

const signalArgument = (
  startArgs: WorkflowStartArgument,
  expectedAggregateVersion: number,
): WorkflowSignalArgument => ({ ...startArgs, expectedAggregateVersion });

export function temporalOperationFor(event: DomainEvent): TemporalOperation {
  switch (event.type) {
    case "jar.created":
    case "jar.closed":
    case "membership.left":
    case "report.expired":
    case "rescue.abandoned":
      return { kind: "audit" };
    case "invite.issued":
      return {
        kind: "start",
        workflowType: "InviteLifecycleWorkflow",
        workflowId: `invite/${event.aggregateId}`,
        args: startArgument("InviteLifecycleWorkflow", event.aggregateId),
      };
    case "invite.superseded":
      return {
        kind: "signal_with_start",
        workflowType: "InviteLifecycleWorkflow",
        workflowId: `invite/${event.aggregateId}`,
        signal: "superseded",
        startArgs: startArgument("InviteLifecycleWorkflow", event.aggregateId),
        signalArgs: signalArgument(
          startArgument("InviteLifecycleWorkflow", event.aggregateId),
          event.aggregateVersion,
        ),
      };
    case "report.created":
      return {
        kind: "start",
        workflowType: "ReportAccountabilityWorkflow",
        workflowId: `report/${event.aggregateId}`,
        args: startArgument("ReportAccountabilityWorkflow", event.aggregateId),
      };
    case "report.owned":
    case "report.denied":
    case "report.jar_closed":
    case "report.member_departed":
      return {
        kind: "signal_with_start",
        workflowType: "ReportAccountabilityWorkflow",
        workflowId: `report/${event.aggregateId}`,
        signal:
          event.type === "report.owned"
            ? "owned"
            : event.type === "report.denied"
              ? "denied"
              : event.type === "report.jar_closed"
                ? "jarClosed"
                : "memberDeparted",
        startArgs: startArgument("ReportAccountabilityWorkflow", event.aggregateId),
        signalArgs: signalArgument(
          startArgument("ReportAccountabilityWorkflow", event.aggregateId),
          event.aggregateVersion,
        ),
      };
    case "rescue.started":
      return {
        kind: "start",
        workflowType: "UrgeRescueWorkflow",
        workflowId: `rescue/${event.aggregateId}`,
        args: startArgument("UrgeRescueWorkflow", event.aggregateId),
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
        startArgs: startArgument("UrgeRescueWorkflow", event.aggregateId),
        signalArgs: signalArgument(
          startArgument("UrgeRescueWorkflow", event.aggregateId),
          event.aggregateVersion,
        ),
      };
    case "notification.requested":
      return {
        kind: "start",
        workflowType: "NotificationDeliveryWorkflow",
        workflowId: `notification/${event.aggregateId}`,
        args: startArgument("NotificationDeliveryWorkflow", event.aggregateId),
      };
    case "account.deletion_requested":
      return {
        kind: "start",
        workflowType: "AccountDeletionWorkflow",
        workflowId: `deletion/${event.aggregateId}`,
        args: startArgument("AccountDeletionWorkflow", event.aggregateId),
      };
    case "membership.joined":
    case "slip.logged":
    case "jar.milestone_crossed":
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
  constructor(
    private readonly client: Client,
    private readonly rpcTimeoutMs = 15_000,
  ) {}
  async execute(
    operation: Exclude<TemporalOperation, { kind: "audit" | "fanout" }>,
  ): Promise<void> {
    await this.client.withDeadline(Date.now() + this.rpcTimeoutMs, async () => {
      try {
        if (operation.kind === "signal_with_start") {
          await this.client.workflow.signalWithStart(operation.workflowType, {
            workflowId: operation.workflowId,
            workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
            taskQueue: "main",
            args: [operation.startArgs],
            signal: operation.signal,
            signalArgs: [operation.signalArgs],
          });
          return;
        }
        await this.client.workflow.start(operation.workflowType, {
          workflowId: operation.workflowId,
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          taskQueue: "main",
          args: [operation.args],
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      }
    });
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
  ReportAccountabilityWorkflow: [
    "report.created",
    "report.owned",
    "report.denied",
    "report.jar_closed",
    "report.member_departed",
  ],
  UrgeRescueWorkflow: ["rescue.started", "rescue.extended", "rescue.safe", "rescue.slipped"],
  NotificationDeliveryWorkflow: ["notification.requested"],
  AccountDeletionWorkflow: ["account.deletion_requested"],
} as const satisfies Record<WorkflowType, readonly DomainEventType[]>;

export function registeredTemporalEventHandlers(
  gateway: TemporalWorkflowGateway,
  workflowTypes: readonly string[],
  additionalHandlers: HandlerRegistry = {},
): HandlerRegistry {
  const handlers: HandlerRegistry = { ...additionalHandlers };
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
const AUDIT_EVENT_TYPES = [
  "jar.created",
  "jar.closed",
  "membership.left",
  "report.expired",
  "rescue.abandoned",
] as const;

export class TemporalWorkflowDispatcher implements WorkflowDispatcher {
  constructor(
    private readonly handlers: HandlerRegistry = {},
    private readonly dispatchFence?: TemporalDispatchFence,
  ) {}

  supportedEventTypes(): readonly DomainEventType[] {
    return [...AUDIT_EVENT_TYPES, ...(Object.keys(this.handlers) as DomainEventType[])];
  }

  async dispatch(event: DomainEvent): Promise<WorkflowDispatchResult> {
    const operation = temporalOperationFor(event);
    if (operation.kind === "audit") return { status: "accepted" };
    const handler = this.handlers[event.type];
    if (!handler) return { status: "permanent", code: "capability_not_registered" };
    try {
      if (
        this.dispatchFence &&
        operation.kind !== "fanout" &&
        operation.workflowType !== "AccountDeletionWorkflow"
      ) {
        await this.dispatchFence.dispatchUnlessSuppressed(operation.workflowId, () =>
          handler.handle(operation, event),
        );
      } else {
        await handler.handle(operation, event);
      }
      return { status: "accepted" };
    } catch {
      return { status: "retryable", code: "temporal_unavailable" };
    }
  }
}
