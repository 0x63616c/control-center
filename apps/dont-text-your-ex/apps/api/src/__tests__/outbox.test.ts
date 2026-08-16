import { describe, expect, it } from "vitest";
import { DomainEventSchema } from "../domain-events";
import { MemoryOutbox } from "../outbox";

const first = DomainEventSchema.parse({
  id: `evt_${"1".repeat(32)}`,
  type: "jar.created",
  schemaVersion: 1,
  aggregateType: "jar",
  aggregateId: `jar_${"1".repeat(32)}`,
  aggregateVersion: 1,
  occurredAt: 10,
});
const second = DomainEventSchema.parse({
  id: `evt_${"2".repeat(32)}`,
  type: "invite.issued",
  schemaVersion: 1,
  aggregateType: "invite",
  aggregateId: `inv_${"2".repeat(32)}`,
  aggregateVersion: 1,
  occurredAt: 20,
});

describe("outbox seam", () => {
  it("leases pending events in occurrence order without concurrent ownership", async () => {
    const outbox = new MemoryOutbox([second, first]);

    await expect(
      outbox.claimPage({ owner: "worker-a", limit: 1, now: 100, leaseUntil: 200 }),
    ).resolves.toEqual([first]);
    await expect(
      outbox.claimPage({ owner: "worker-b", limit: 2, now: 100, leaseUntil: 300 }),
    ).resolves.toEqual([second]);
    await expect(
      outbox.claimPage({ owner: "worker-b", limit: 2, now: 201, leaseUntil: 300 }),
    ).resolves.toEqual([first]);
  });

  it("acknowledges only the lease owner and reschedules retryable failures", async () => {
    const outbox = new MemoryOutbox([first]);
    await outbox.claimPage({ owner: "worker-a", limit: 1, now: 100, leaseUntil: 200 });

    await expect(
      outbox.markAccepted({ eventId: first.id, owner: "worker-b", at: 110 }),
    ).resolves.toBe(false);
    await expect(
      outbox.reschedule({
        eventId: first.id,
        owner: "worker-a",
        at: 110,
        availableAt: 150,
        code: "temporal_unavailable",
      }),
    ).resolves.toEqual({ status: "rescheduled" });
    await expect(
      outbox.claimPage({ owner: "worker-b", limit: 1, now: 149, leaseUntil: 200 }),
    ).resolves.toEqual([]);
    await expect(
      outbox.claimPage({ owner: "worker-b", limit: 1, now: 150, leaseUntil: 200 }),
    ).resolves.toEqual([first]);
  });

  it("quarantines poison events without blocking later work", async () => {
    const outbox = new MemoryOutbox([first, second]);
    await outbox.claimPage({ owner: "worker-a", limit: 1, now: 100, leaseUntil: 200 });
    await expect(
      outbox.markFailed({ eventId: first.id, owner: "worker-a", at: 110, code: "unsupported" }),
    ).resolves.toBe(true);

    await expect(
      outbox.claimPage({ owner: "worker-b", limit: 2, now: 120, leaseUntil: 200 }),
    ).resolves.toEqual([second]);
  });

  it("quarantines a repeatedly retryable poison event after the declared attempt limit", async () => {
    const outbox = new MemoryOutbox([first], { maxAttempts: 2 });
    await outbox.claimPage({ owner: "worker-a", limit: 1, now: 100, leaseUntil: 110 });
    await expect(
      outbox.reschedule({
        eventId: first.id,
        owner: "worker-a",
        at: 101,
        availableAt: 102,
        code: "still_broken",
      }),
    ).resolves.toEqual({ status: "rescheduled" });
    await outbox.claimPage({ owner: "worker-b", limit: 1, now: 102, leaseUntil: 110 });
    await expect(
      outbox.reschedule({
        eventId: first.id,
        owner: "worker-b",
        at: 103,
        availableAt: 104,
        code: "still_broken",
      }),
    ).resolves.toEqual({ status: "failed" });
    await expect(
      outbox.claimPage({ owner: "worker-c", limit: 1, now: 200, leaseUntil: 300 }),
    ).resolves.toEqual([]);
  });
});
