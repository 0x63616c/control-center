import { describe, expect, it } from "vitest";
import { DomainEventSchema } from "../domain-events";
import { RecordingWorkflowDispatcher } from "../workflow-dispatcher";

describe("workflow dispatcher seam", () => {
  it("records accepted events through the same interface as the future Temporal adapter", async () => {
    const dispatcher = new RecordingWorkflowDispatcher();
    const event = DomainEventSchema.parse({
      id: "evt_example",
      type: "invite.issued",
      schemaVersion: 1,
      aggregateType: "invite",
      aggregateId: "inv_example",
      aggregateVersion: 1,
      occurredAt: 1,
    });

    await expect(dispatcher.dispatch(event)).resolves.toEqual({ status: "accepted" });
    expect(dispatcher.events()).toEqual([event]);
  });

  it("can script retryable and permanent outcomes without exposing implementation details", async () => {
    const dispatcher = new RecordingWorkflowDispatcher([
      { status: "retryable", code: "temporal_unavailable" },
      { status: "permanent", code: "unsupported_event_version" },
    ]);
    const event = DomainEventSchema.parse({
      id: "evt_example",
      type: "jar.created",
      schemaVersion: 1,
      aggregateType: "jar",
      aggregateId: "jar_example",
      aggregateVersion: 1,
      occurredAt: 1,
    });

    await expect(dispatcher.dispatch(event)).resolves.toEqual({
      status: "retryable",
      code: "temporal_unavailable",
    });
    await expect(dispatcher.dispatch(event)).resolves.toEqual({
      status: "permanent",
      code: "unsupported_event_version",
    });
  });
});
