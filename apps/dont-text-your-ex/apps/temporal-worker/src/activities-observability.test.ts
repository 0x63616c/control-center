import { describe, expect, test, vi } from "vitest";
import { DomainEventSchema } from "../../api/src/domain-events";
import { MemoryOutbox } from "../../api/src/outbox";
import { RecordingWorkflowDispatcher } from "../../api/src/workflow-dispatcher";
import { createDtyeActivities } from "./activities";
import type { NotificationActivities } from "./notification-activities";
import type { DtyeOperationsObserver } from "./operations-observability";
import type { ReportAccountabilityStore } from "./report-accountability";
import { MemorySessionMaintenanceStore } from "./session-maintenance";

const event = DomainEventSchema.parse({
  id: `evt_${"a".repeat(32)}`,
  type: "jar.created",
  schemaVersion: 1,
  aggregateType: "jar",
  aggregateId: `jar_${"a".repeat(32)}`,
  aggregateVersion: 1,
  occurredAt: 1_000,
});

const notifications: NotificationActivities = {
  prepareNotification: async () => ({ deliveryIds: [] }),
  deliverNotification: async () => ({ kind: "already_terminal", state: "suppressed" }),
  suppressNotification: async () => undefined,
  rotatePushTokenBatch: async () => ({ rotated: 0 }),
};
const streakMilestones = {
  StreakMilestoneSweepActivity: async () => ({
    candidates: 0,
    achievements: 0,
    notifications: 0,
    sharedActivities: 0,
    hasMore: false,
  }),
};

const reports: ReportAccountabilityStore = {
  advance: async () => {
    throw new Error("report activity was not expected");
  },
};

const rescue = {
  loadRescue: async () => null,
  advanceRescueAtDeadline: async () => null,
  eraseRescueForAccountDeletion: async () => ({ erased: true as const }),
};

const invites = {
  loadInviteLifecycle: async () => ({ kind: "superseded" as const }),
  requestInviteReminder: async () => ({ kind: "superseded" as const }),
};

function recordingObserver() {
  const observer: DtyeOperationsObserver = {
    accountDeletionErasureStuck: vi.fn(),
    outboxSnapshot: vi.fn(),
    outboxDispatch: vi.fn(),
    outboxRecoverySucceeded: vi.fn(),
    sessionPurge: vi.fn(),
  };
  return observer;
}

describe("DTYE activity observability", () => {
  test("records accepted queue latency and a durable backlog snapshot without IDs", async () => {
    const operations = recordingObserver();
    const activities = createDtyeActivities({
      outbox: new MemoryOutbox([event]),
      dispatcher: new RecordingWorkflowDispatcher([], ["jar.created"]),
      sessions: new MemorySessionMaintenanceStore(),
      notifications,
      reports,
      rescue,
      streakMilestones,
      invites,
      operations,
      outboxSnapshot: {
        snapshot: vi.fn(async () => ({ pending: 0, oldestAgeSeconds: 0, permanentFailures: 0 })),
      },
      clock: () => 6_000,
    });

    await expect(activities.OutboxDispatchActivity({ limit: 100 })).resolves.toEqual({
      claimed: 1,
      accepted: 1,
      retried: 0,
      failed: 0,
    });
    expect(operations.outboxDispatch).toHaveBeenCalledWith({
      outcome: "accepted",
      latencySeconds: 5,
    });
    expect(operations.outboxSnapshot).toHaveBeenCalledWith({
      pending: 0,
      oldestAgeSeconds: 0,
      permanentFailures: 0,
    });
    expect(JSON.stringify(vi.mocked(operations.outboxDispatch).mock.calls)).not.toMatch(
      /evt_|jar_/,
    );
    expect(operations.outboxRecoverySucceeded).toHaveBeenCalledWith(6_000);
  });

  test("a targeted post-commit nudge cannot mask a silent recovery schedule", async () => {
    const operations = recordingObserver();
    const activities = createDtyeActivities({
      outbox: new MemoryOutbox([event]),
      dispatcher: new RecordingWorkflowDispatcher([], ["jar.created"]),
      sessions: new MemorySessionMaintenanceStore(),
      notifications,
      reports,
      rescue,
      streakMilestones,
      invites,
      operations,
      outboxSnapshot: {
        snapshot: vi.fn(async () => ({ pending: 0, oldestAgeSeconds: 0, permanentFailures: 0 })),
      },
      clock: () => 6_000,
    });
    await activities.OutboxDispatchActivity({ limit: 100, eventIds: [event.id] });
    expect(operations.outboxRecoverySucceeded).not.toHaveBeenCalled();
  });

  test("records retry outcomes and continues after a snapshot collector failure", async () => {
    const operations = recordingObserver();
    const activities = createDtyeActivities({
      outbox: new MemoryOutbox([event]),
      dispatcher: new RecordingWorkflowDispatcher(
        [{ status: "retryable", code: "temporal_unavailable" }],
        ["jar.created"],
      ),
      sessions: new MemorySessionMaintenanceStore(),
      notifications,
      reports,
      rescue,
      streakMilestones,
      invites,
      operations,
      outboxSnapshot: { snapshot: vi.fn(async () => Promise.reject(new Error("db unavailable"))) },
      clock: () => 6_000,
    });

    await expect(activities.OutboxDispatchActivity({ limit: 100 })).resolves.toMatchObject({
      retried: 1,
    });
    expect(operations.outboxDispatch).toHaveBeenCalledWith({ outcome: "retry" });
  });

  test("records bounded session purge success and failure outcomes", async () => {
    const successObserver = recordingObserver();
    const clockValues = [1_000, 1_250];
    const success = createDtyeActivities({
      outbox: new MemoryOutbox(),
      dispatcher: new RecordingWorkflowDispatcher(),
      sessions: new MemorySessionMaintenanceStore([{ token: "secret", expiresAt: 1 }]),
      notifications,
      reports,
      rescue,
      streakMilestones,
      invites,
      operations: successObserver,
      outboxSnapshot: { snapshot: vi.fn() },
      clock: () => clockValues.shift() ?? 1_250,
    });
    await success.SessionMaintenanceActivity({ now: 100, limit: 500 });
    expect(successObserver.sessionPurge).toHaveBeenCalledWith({
      outcome: "success",
      deleted: 1,
      durationSeconds: 0.25,
      completedAtMs: 1_250,
    });

    const failureObserver = recordingObserver();
    const failure = createDtyeActivities({
      outbox: new MemoryOutbox(),
      dispatcher: new RecordingWorkflowDispatcher(),
      sessions: { purgeExpired: vi.fn(async () => Promise.reject(new Error("database down"))) },
      notifications,
      reports,
      rescue,
      streakMilestones,
      invites,
      operations: failureObserver,
      outboxSnapshot: { snapshot: vi.fn() },
      clock: () => 2_000,
    });
    await expect(failure.SessionMaintenanceActivity({ now: 100, limit: 500 })).rejects.toThrow(
      "database down",
    );
    expect(failureObserver.sessionPurge).toHaveBeenCalledWith({
      outcome: "failure",
      deleted: 0,
      durationSeconds: 0,
      completedAtMs: 2_000,
    });
  });
});
