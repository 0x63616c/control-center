import type { Pool } from "pg";

function workflowLockKey(workflowId: string): string {
  return `dont-text-your-ex/workflow/${workflowId}`;
}

export interface AccountDeletionWorkflowFence {
  withCleanupFence<T>(workflowId: string, effect: () => Promise<T>): Promise<T>;
}

export interface TemporalDispatchFence {
  dispatchUnlessSuppressed(workflowId: string, effect: () => Promise<void>): Promise<boolean>;
}

export class PostgresTemporalWorkflowFence
  implements AccountDeletionWorkflowFence, TemporalDispatchFence
{
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async withCleanupFence<T>(workflowId: string, effect: () => Promise<T>): Promise<T> {
    return this.withLock("pg_advisory_xact_lock", workflowId, effect);
  }

  async dispatchUnlessSuppressed(
    workflowId: string,
    effect: () => Promise<void>,
  ): Promise<boolean> {
    return this.withLock("pg_advisory_xact_lock_shared", workflowId, async (client) => {
      const suppressed = await client.query(
        `SELECT 1 FROM account_deletion_cleanup_item
         WHERE workflow_id=$1 LIMIT 1`,
        [workflowId],
      );
      if (suppressed.rowCount) return false;
      await effect();
      return true;
    });
  }

  private async withLock<T>(
    lockFunction: "pg_advisory_xact_lock" | "pg_advisory_xact_lock_shared",
    workflowId: string,
    effect: (client: Pick<Pool, "query">) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT ${lockFunction}(hashtextextended($1,0))`, [
        workflowLockKey(workflowId),
      ]);
      const result = await effect(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
