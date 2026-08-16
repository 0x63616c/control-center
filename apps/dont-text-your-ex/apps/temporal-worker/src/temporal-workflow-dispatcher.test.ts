import { describe, expect, it } from "vitest";
import { DomainEventSchema } from "../../api/src/domain-events";
import {
  RecordingTemporalEventHandler,
  ReportAccountabilityFanoutHandler,
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
      "report.expired",
      "rescue.abandoned",
      "invite.issued",
    ]);
    await expect(dispatcher.dispatch(inviteIssued)).resolves.toEqual({ status: "accepted" });
    expect(handler.operations()).toEqual([temporalOperationFor(inviteIssued)]);
  });

  it.each([
    ["jar.closed", "jar", "jar_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "jarClosed"],
    [
      "membership.left",
      "membership_tenure",
      "mtn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "memberDeparted",
    ],
  ] as const)("fans out %s to opaque report signals", async (type, aggregateType, aggregateId, signal) => {
    const operations: unknown[] = [];
    const gateway = { execute: async (operation: unknown) => operations.push(operation) };
    const handler = new ReportAccountabilityFanoutHandler(gateway as never, {
      signalTargets: async () => [
        {
          reportId: "rpt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as never,
          aggregateVersion: 1,
        },
      ],
    });
    const event = DomainEventSchema.parse({
      id: "evt_dddddddddddddddddddddddddddddddd",
      type,
      schemaVersion: 1,
      aggregateType,
      aggregateId,
      aggregateVersion: 2,
      occurredAt: 2,
    });

    await handler.handle(temporalOperationFor(event), event);

    expect(operations).toEqual([
      {
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
      },
    ]);
    expect(JSON.stringify(operations)).not.toContain("usr_");
  });
});
