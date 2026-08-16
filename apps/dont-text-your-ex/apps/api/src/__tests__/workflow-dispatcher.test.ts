import { describe, expect, it } from "vitest";
import { DomainEventSchema } from "../domain-events";
import { MemoryOutbox } from "../outbox";
import { dispatchOutboxPage, RecordingWorkflowDispatcher } from "../workflow-dispatcher";

describe("workflow dispatcher seam", () => {
  it("records accepted events through the same interface as the future Temporal adapter", async () => {
    const dispatcher = new RecordingWorkflowDispatcher();
    const event = DomainEventSchema.parse({
      id: `evt_${"1".repeat(32)}`,
      type: "invite.issued",
      schemaVersion: 1,
      aggregateType: "invite",
      aggregateId: `inv_${"1".repeat(32)}`,
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
      id: `evt_${"2".repeat(32)}`,
      type: "jar.created",
      schemaVersion: 1,
      aggregateType: "jar",
      aggregateId: `jar_${"2".repeat(32)}`,
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

  it("acknowledges accepted events while retrying and quarantining independent failures", async () => {
    const accepted = DomainEventSchema.parse({
      id: `evt_${"3".repeat(32)}`,
      type: "jar.created",
      schemaVersion: 1,
      aggregateType: "jar",
      aggregateId: `jar_${"3".repeat(32)}`,
      aggregateVersion: 1,
      occurredAt: 1,
    });
    const retryable = DomainEventSchema.parse({
      id: `evt_${"4".repeat(32)}`,
      type: "invite.issued",
      schemaVersion: 1,
      aggregateType: "invite",
      aggregateId: `inv_${"4".repeat(32)}`,
      aggregateVersion: 1,
      occurredAt: 2,
    });
    const permanent = DomainEventSchema.parse({
      id: `evt_${"5".repeat(32)}`,
      type: "report.created",
      schemaVersion: 1,
      aggregateType: "report",
      aggregateId: `rpt_${"5".repeat(32)}`,
      aggregateVersion: 1,
      occurredAt: 3,
    });
    const outbox = new MemoryOutbox([accepted, retryable, permanent]);
    const dispatcher = new RecordingWorkflowDispatcher([
      { status: "accepted" },
      { status: "retryable", code: "temporal_unavailable" },
      { status: "permanent", code: "unsupported_event_version" },
    ]);

    await expect(
      dispatchOutboxPage({
        outbox,
        dispatcher,
        owner: "worker-a",
        limit: 10,
        now: 10,
        leaseUntil: 20,
        retryAt: 30,
      }),
    ).resolves.toEqual({ claimed: 3, accepted: 1, retried: 1, failed: 1 });
    await expect(
      outbox.claimPage({ owner: "worker-b", limit: 10, now: 29, leaseUntil: 40 }),
    ).resolves.toEqual([]);
    await expect(
      outbox.claimPage({ owner: "worker-b", limit: 10, now: 30, leaseUntil: 40 }),
    ).resolves.toEqual([retryable]);
  });

  it("leaves unsupported events pending until a dispatcher registers their capability", async () => {
    const event = DomainEventSchema.parse({
      id: "evt_later",
      type: "invite.issued",
      schemaVersion: 1,
      aggregateType: "invite",
      aggregateId: "inv_later",
      aggregateVersion: 1,
      occurredAt: 1,
    });
    const outbox = new MemoryOutbox([event]);
    const unsupported = new RecordingWorkflowDispatcher([], ["jar.created"]);

    await expect(
      dispatchOutboxPage({
        outbox,
        dispatcher: unsupported,
        owner: "worker-a",
        limit: 10,
        now: 10,
        leaseUntil: 20,
        retryAt: 30,
      }),
    ).resolves.toEqual({ claimed: 0, accepted: 0, retried: 0, failed: 0 });

    const enabled = new RecordingWorkflowDispatcher([], ["invite.issued"]);
    await expect(
      dispatchOutboxPage({
        outbox,
        dispatcher: enabled,
        owner: "worker-b",
        limit: 10,
        now: 10,
        leaseUntil: 20,
        retryAt: 30,
      }),
    ).resolves.toEqual({ claimed: 1, accepted: 1, retried: 0, failed: 0 });
    expect(enabled.events()).toEqual([event]);
  });
});
