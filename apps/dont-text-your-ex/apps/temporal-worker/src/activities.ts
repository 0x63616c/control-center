import { randomUUID } from "node:crypto";
import type { DomainEvent } from "../../api/src/domain-events";
import type { Outbox } from "../../api/src/outbox";
import { dispatchOutboxPage, type WorkflowDispatcher } from "../../api/src/workflow-dispatcher";
import type { AccountDeletionActivities } from "./account-deletion";
import type { InviteLifecycleActivities } from "./invite-lifecycle";
import type { NotificationActivities } from "./notification-activities";
import type {
  DtyeOperationsObserver,
  OutboxOperationalSnapshotStore,
} from "./operations-observability";
import {
  createReportAccountabilityActivities,
  type ReportAccountabilityStore,
} from "./report-accountability";
import type { RescueActivities } from "./rescue-activities";
import { runSessionMaintenancePage, type SessionMaintenanceStore } from "./session-maintenance";
import type { StreakMilestoneActivities } from "./streak-milestones";

interface DtyeHealthCheckActivityInput {
  readonly iteration: number;
}
interface DtyeHealthCheckActivityOutput {
  readonly status: "ok";
}

async function DtyeHealthCheckActivity(
  input: DtyeHealthCheckActivityInput,
): Promise<DtyeHealthCheckActivityOutput> {
  void input;
  return { status: "ok" };
}

export const OUTBOX_DISPATCH_ACTIVITY_TIMEOUT_MS = 25_000;
export const OUTBOX_DISPATCH_LEASE_MS = 30_000;

export interface OutboxDispatchActivityInput {
  readonly eventIds?: readonly DomainEvent["id"][];
  readonly limit: number;
}
export interface OutboxDispatchActivityOutput {
  readonly claimed: number;
  readonly accepted: number;
  readonly retried: number;
  readonly failed: number;
}
export interface SessionMaintenanceActivityInput {
  readonly now: number;
  readonly limit: number;
}

export type DtyeActivityDependencies = Readonly<{
  outbox: Outbox;
  dispatcher: WorkflowDispatcher;
  sessions: SessionMaintenanceStore;
  notifications: NotificationActivities;
  streakMilestones: StreakMilestoneActivities;
  operations: DtyeOperationsObserver;
  outboxSnapshot: OutboxOperationalSnapshotStore;
  reports: ReportAccountabilityStore;
  rescue: RescueActivities;
  invites: InviteLifecycleActivities;
  accountDeletion?: AccountDeletionActivities;
  clock?: () => number;
}>;

export function createDtyeActivities(dependencies: DtyeActivityDependencies) {
  const clock = dependencies.clock ?? Date.now;
  const missingAccountDeletion = async (): Promise<never> => {
    throw new Error("account deletion activities are not configured");
  };
  const accountDeletion =
    dependencies.accountDeletion ??
    ({
      eraseAccountLocally: missingAccountDeletion,
      revokeAppleCredential: missingAccountDeletion,
      finishAccountDeletion: missingAccountDeletion,
      terminateAssociatedWorkflows: missingAccountDeletion,
      deleteAssociatedWorkflowHistories: missingAccountDeletion,
      sweepAccountDeletionHistories: missingAccountDeletion,
      purgeExpiredAccountDeletionRecords: missingAccountDeletion,
      recordAccountDeletionErasureStuck: missingAccountDeletion,
    } satisfies AccountDeletionActivities);
  return {
    DtyeHealthCheckActivity,
    async OutboxDispatchActivity(
      input: OutboxDispatchActivityInput,
    ): Promise<OutboxDispatchActivityOutput> {
      const now = clock();
      const result = await dispatchOutboxPage({
        outbox: dependencies.outbox,
        dispatcher: dependencies.dispatcher,
        owner: `outbox-${randomUUID()}`,
        // A single bounded Temporal RPC must finish before this row's lease expires.
        // The workflow drains up to 20 events, then continues as new.
        limit: Math.min(input.limit, 1),
        now,
        leaseUntil: now + OUTBOX_DISPATCH_LEASE_MS,
        retryAt: now + 60_000,
        eventIds: input.eventIds,
        onAccepted: (observation) =>
          dependencies.operations.outboxDispatch({ outcome: "accepted", ...observation }),
      });
      for (let index = 0; index < result.retried; index += 1) {
        dependencies.operations.outboxDispatch({ outcome: "retry" });
      }
      for (let index = 0; index < result.failed; index += 1) {
        dependencies.operations.outboxDispatch({ outcome: "permanent_failure" });
      }
      // A targeted post-commit nudge must not mask a dead managed Schedule.
      // Only the unfiltered recovery activity proves the recovery path ran.
      if (input.eventIds === undefined) dependencies.operations.outboxRecoverySucceeded(clock());
      try {
        dependencies.operations.outboxSnapshot(await dependencies.outboxSnapshot.snapshot(clock()));
      } catch {
        // Dispatch is authoritative. A scrape snapshot must never make an
        // already-accepted page retry and replay its Temporal operations.
      }
      return result;
    },
    async SessionMaintenanceActivity(input: SessionMaintenanceActivityInput) {
      const startedAt = clock();
      try {
        const result = await runSessionMaintenancePage({ store: dependencies.sessions, ...input });
        const completedAt = clock();
        dependencies.operations.sessionPurge({
          outcome: "success",
          deleted: result.deleted,
          durationSeconds: Math.max(0, completedAt - startedAt) / 1000,
          completedAtMs: completedAt,
        });
        return result;
      } catch (error) {
        const completedAt = clock();
        dependencies.operations.sessionPurge({
          outcome: "failure",
          deleted: 0,
          durationSeconds: Math.max(0, completedAt - startedAt) / 1000,
          completedAtMs: completedAt,
        });
        throw error;
      }
    },
    ...dependencies.notifications,
    ...createReportAccountabilityActivities({ store: dependencies.reports }),
    ...dependencies.rescue,
    ...dependencies.streakMilestones,
    ...dependencies.invites,
    ...accountDeletion,
  };
}

export type DtyeActivities = ReturnType<typeof createDtyeActivities>;
