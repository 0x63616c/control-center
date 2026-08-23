import { WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";
import { DomainEventSchema } from "../../api/src/domain-events";
import {
  RecordingTemporalEventHandler,
  TemporalClientWorkflowGateway,
  TemporalWorkflowDispatcher,
  temporalOperationFor,
} from "./temporal-workflow-dispatcher";

const inviteIssued = DomainEventSchema.parse({
  id: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  type: "invite.issued",
  schemaVersion: 1,
  aggregateType: "invite",
  aggregateId: "inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  aggregateVersion: 1,
  occurredAt: 1,
});

describe("Temporal workflow dispatcher", () => {
  it("maps directly addressable lifecycle events to stable Temporal operations", () => {
    expect(temporalOperationFor(inviteIssued)).toEqual({
      kind: "start",
      workflowType: "InviteLifecycleWorkflow",
      workflowId: "invite/inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      args: {
        inviteVersionId: "inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        schemaVersion: 1,
      },
    });
    expect(
      temporalOperationFor(
        DomainEventSchema.parse({
          ...inviteIssued,
          id: "evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          type: "invite.superseded",
          aggregateVersion: 2,
        }),
      ),
    ).toEqual({
      kind: "signal_with_start",
      workflowType: "InviteLifecycleWorkflow",
      workflowId: "invite/inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      signal: "superseded",
      startArgs: {
        inviteVersionId: "inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        schemaVersion: 1,
      },
      signalArgs: {
        inviteVersionId: "inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expectedAggregateVersion: 2,
        schemaVersion: 1,
      },
    });
  });

  it("rejects workflow id reuse and accepts a duplicate after completion", async () => {
    const start = vi.fn(async () => undefined);
    const signalWithStart = vi.fn(async () => undefined);
    const client = {
      withDeadline: vi.fn(async (_deadline: number, operation: () => Promise<void>) => operation()),
      workflow: { start, signalWithStart },
    };
    const gateway = new TemporalClientWorkflowGateway(client as never);
    const startOperation = temporalOperationFor(inviteIssued);
    const signalOperation = temporalOperationFor(
      DomainEventSchema.parse({
        ...inviteIssued,
        id: "evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        type: "invite.superseded",
        aggregateVersion: 2,
      }),
    );
    if (startOperation.kind !== "start" || signalOperation.kind !== "signal_with_start") {
      throw new Error("expected direct Temporal operations");
    }

    await gateway.execute(startOperation);
    await gateway.execute(signalOperation);
    expect(start).toHaveBeenCalledWith(
      "InviteLifecycleWorkflow",
      expect.objectContaining({ workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE }),
    );
    expect(signalWithStart).toHaveBeenCalledWith(
      "InviteLifecycleWorkflow",
      expect.objectContaining({ workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE }),
    );

    start.mockRejectedValueOnce(
      new WorkflowExecutionAlreadyStartedError(
        "already completed",
        startOperation.workflowId,
        startOperation.workflowType,
      ) as never,
    );
    signalWithStart.mockRejectedValueOnce(
      new WorkflowExecutionAlreadyStartedError(
        "already completed",
        signalOperation.workflowId,
        signalOperation.workflowType,
      ) as never,
    );
    await expect(gateway.execute(startOperation)).resolves.toBeUndefined();
    await expect(gateway.execute(signalOperation)).resolves.toBeUndefined();
  });

  it("uses the notification workflow's exact privacy-safe input contract", () => {
    expect(
      temporalOperationFor(
        DomainEventSchema.parse({
          ...inviteIssued,
          id: "evt_cccccccccccccccccccccccccccccccc",
          type: "notification.requested",
          aggregateType: "notification",
          aggregateId: "ntf_cccccccccccccccccccccccccccccccc",
        }),
      ),
    ).toEqual({
      kind: "start",
      workflowType: "NotificationDeliveryWorkflow",
      workflowId: "notification/ntf_cccccccccccccccccccccccccccccccc",
      args: {
        schemaVersion: 1,
        notificationId: "ntf_cccccccccccccccccccccccccccccccc",
      },
    });
  });

  it("advertises only audit facts and handlers backed by registered workflow exports", async () => {
    const handler = new RecordingTemporalEventHandler();
    const dispatcher = new TemporalWorkflowDispatcher({ "invite.issued": handler });
    expect(dispatcher.supportedEventTypes()).toEqual([
      "jar.created",
      "jar.closed",
      "membership.left",
      "report.expired",
      "rescue.abandoned",
      "invite.issued",
    ]);
    await expect(dispatcher.dispatch(inviteIssued)).resolves.toEqual({ status: "accepted" });
    expect(handler.operations()).toEqual([temporalOperationFor(inviteIssued)]);
  });

  it("acknowledges an inventoried stale event without recreating its Temporal workflow", async () => {
    const handler = new RecordingTemporalEventHandler();
    const dispatchUnlessSuppressed = vi.fn(async () => false);
    const dispatcher = new TemporalWorkflowDispatcher(
      { "invite.issued": handler },
      { dispatchUnlessSuppressed },
    );

    await expect(dispatcher.dispatch(inviteIssued)).resolves.toEqual({ status: "accepted" });
    expect(dispatchUnlessSuppressed).toHaveBeenCalledWith(
      "invite/inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      expect.any(Function),
    );
    expect(handler.operations()).toEqual([]);
  });

  it.each([
    ["report.jar_closed", "jarClosed"],
    ["report.member_departed", "memberDeparted"],
  ] as const)("maps %s to one durable opaque report signal", (type, signal) => {
    const event = DomainEventSchema.parse({
      id: "evt_dddddddddddddddddddddddddddddddd",
      type,
      schemaVersion: 1,
      aggregateType: "report",
      aggregateId: "rpt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      aggregateVersion: 1,
      occurredAt: 2,
    });

    expect(temporalOperationFor(event)).toEqual({
      kind: "signal_with_start",
      workflowType: "ReportAccountabilityWorkflow",
      workflowId: "report/rpt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      signal,
      startArgs: {
        schemaVersion: 1,
        reportId: "rpt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      signalArgs: {
        schemaVersion: 1,
        reportId: "rpt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expectedAggregateVersion: 1,
      },
    });
  });

  it("accepts report expiry as a terminal audit fact", async () => {
    const dispatcher = new TemporalWorkflowDispatcher();
    const expired = DomainEventSchema.parse({
      id: "evt_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      type: "report.expired",
      schemaVersion: 1,
      aggregateType: "report",
      aggregateId: "rpt_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      aggregateVersion: 2,
      occurredAt: 2,
    });

    await expect(dispatcher.dispatch(expired)).resolves.toEqual({ status: "accepted" });
  });
});
