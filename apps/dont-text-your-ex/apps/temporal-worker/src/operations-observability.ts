import {
  type DtyeOutboxSnapshot,
  observeDtyeAccountDeletionErasureStuck,
  observeDtyeOutboxDispatch,
  observeDtyeOutboxRecoverySuccess,
  observeDtyeOutboxSnapshot,
  observeDtyeSessionPurge,
} from "@www/platform/metrics";
import type { Pool } from "pg";

export interface OutboxOperationalSnapshotStore {
  snapshot(now: number): Promise<DtyeOutboxSnapshot>;
}

export interface DtyeOperationsObserver {
  accountDeletionErasureStuck(): void;
  outboxSnapshot(snapshot: DtyeOutboxSnapshot): void;
  outboxDispatch(
    input: Readonly<{
      outcome: "accepted" | "retry" | "permanent_failure";
      latencySeconds?: number;
    }>,
  ): void;
  outboxRecoverySucceeded(completedAtMs: number): void;
  sessionPurge(
    input: Readonly<{
      outcome: "success" | "failure";
      deleted: number;
      durationSeconds: number;
      completedAtMs: number;
    }>,
  ): void;
}

export const platformDtyeOperationsObserver: DtyeOperationsObserver = {
  accountDeletionErasureStuck: observeDtyeAccountDeletionErasureStuck,
  outboxSnapshot: observeDtyeOutboxSnapshot,
  outboxDispatch: observeDtyeOutboxDispatch,
  outboxRecoverySucceeded: observeDtyeOutboxRecoverySuccess,
  sessionPurge: observeDtyeSessionPurge,
};

type SnapshotRow = {
  pending: string;
  oldest_occurred_at: string | null;
  permanent_failures: string;
};

export class PostgresOutboxOperationalSnapshotStore implements OutboxOperationalSnapshotStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async snapshot(now: number): Promise<DtyeOutboxSnapshot> {
    const result = await this.pool.query<SnapshotRow>(
      `SELECT
         COUNT(*) FILTER (WHERE state IN ('pending', 'claimed')) AS pending,
         MIN(occurred_at) FILTER (WHERE state IN ('pending', 'claimed')) AS oldest_occurred_at,
         COUNT(*) FILTER (WHERE state = 'failed') AS permanent_failures
       FROM domain_event`,
    );
    const row = result.rows[0];
    const oldestOccurredAt = row?.oldest_occurred_at;
    return {
      pending: Number(row?.pending ?? 0),
      oldestAgeSeconds:
        oldestOccurredAt === null || oldestOccurredAt === undefined
          ? 0
          : Math.max(0, now - Number(oldestOccurredAt)) / 1000,
      permanentFailures: Number(row?.permanent_failures ?? 0),
    };
  }
}
