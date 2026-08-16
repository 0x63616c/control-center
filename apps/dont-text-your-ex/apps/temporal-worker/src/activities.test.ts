import { describe, expect, it } from "vitest";
import { DomainEventSchema } from "../../api/src/domain-events";
import { MemoryOutbox } from "../../api/src/outbox";
import { RecordingWorkflowDispatcher } from "../../api/src/workflow-dispatcher";
import {
  createDtyeActivities,
  OUTBOX_DISPATCH_ACTIVITY_TIMEOUT_MS,
  OUTBOX_DISPATCH_LEASE_MS,
} from "./activities";

const events = ["a", "b"].map((suffix, index) =>
  DomainEventSchema.parse({
    id: `evt_${suffix.repeat(32)}`,
    type: "jar.created",
    schemaVersion: 1,
    aggregateType: "jar",
    aggregateId: `jar_${suffix.repeat(32)}`,
    aggregateVersion: 1,
    occurredAt: index + 1,
  }),
);

describe("outbox dispatch activity", () => {
  it("claims one event and holds its lease beyond the hard activity timeout", async () => {
    const dispatcher = new RecordingWorkflowDispatcher();
    const activities = createDtyeActivities({
      outbox: new MemoryOutbox(events),
      dispatcher,
      sessions: { purgeExpired: async () => ({ deleted: 0 }) },
      notifications: {
        prepareNotification: async () => ({ deliveryIds: [] }),
        deliverNotification: async () => ({ kind: "already_terminal", state: "suppressed" }),
        suppressNotification: async () => undefined,
        rotatePushTokenBatch: async () => ({ rotated: 0 }),
      },
      streakMilestones: {
        StreakMilestoneSweepActivity: async () => ({
          candidates: 0,
          achievements: 0,
          notifications: 0,
          sharedActivities: 0,
          hasMore: false,
        }),
      },
      operations: {
        outboxSnapshot: () => undefined,
        outboxDispatch: () => undefined,
        outboxRecoverySucceeded: () => undefined,
        sessionPurge: () => undefined,
      },
      outboxSnapshot: {
        snapshot: async () => ({ pending: 0, oldestAgeSeconds: 0, permanentFailures: 0 }),
      },
      reports: {
        advance: async ({ reportId }) => ({
          state: "member_departed",
          reportId,
          aggregateVersion: 1,
        }),
      },
      rescue: {
        loadRescue: async () => null,
        advanceRescueAtDeadline: async () => null,
        eraseRescueForAccountDeletion: async () => ({ erased: true }),
      },
      clock: () => 10,
    });

    await expect(activities.OutboxDispatchActivity({ limit: 100 })).resolves.toEqual({
      claimed: 1,
      accepted: 1,
      retried: 0,
      failed: 0,
    });
    expect(dispatcher.events()).toEqual([events[0]]);
    expect(OUTBOX_DISPATCH_LEASE_MS).toBeGreaterThan(OUTBOX_DISPATCH_ACTIVITY_TIMEOUT_MS);
  });
});
