import { randomUUID } from "node:crypto";
import type { DomainEvent } from "../../api/src/domain-events";
import type { Outbox } from "../../api/src/outbox";
import { dispatchOutboxPage, type WorkflowDispatcher } from "../../api/src/workflow-dispatcher";
import type { NotificationActivities } from "./notification-activities";
import { runSessionMaintenancePage, type SessionMaintenanceStore } from "./session-maintenance";

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
  clock?: () => number;
}>;

export function createDtyeActivities(dependencies: DtyeActivityDependencies) {
  const clock = dependencies.clock ?? Date.now;
  return {
    DtyeHealthCheckActivity,
    async OutboxDispatchActivity(
      input: OutboxDispatchActivityInput,
    ): Promise<OutboxDispatchActivityOutput> {
      const now = clock();
      return dispatchOutboxPage({
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
      });
    },
    async SessionMaintenanceActivity(input: SessionMaintenanceActivityInput) {
      return runSessionMaintenancePage({ store: dependencies.sessions, ...input });
    },
    ...dependencies.notifications,
  };
}

export type DtyeActivities = ReturnType<typeof createDtyeActivities>;
