import { describe, expect, it } from "vitest";
import { DomainEventSchema } from "../../api/src/domain-events";
import {
  RecordingTemporalEventHandler,
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
        aggregateId: "inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        aggregateVersion: 1,
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
      args: {
        aggregateId: "inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        aggregateVersion: 2,
        schemaVersion: 1,
      },
    });
  });

  it("advertises only audit facts and handlers backed by registered workflow exports", async () => {
    const handler = new RecordingTemporalEventHandler();
    const dispatcher = new TemporalWorkflowDispatcher({ "invite.issued": handler });
    expect(dispatcher.supportedEventTypes()).toEqual(["jar.created", "invite.issued"]);
    await expect(dispatcher.dispatch(inviteIssued)).resolves.toEqual({ status: "accepted" });
    expect(handler.operations()).toEqual([temporalOperationFor(inviteIssued)]);
  });
});
