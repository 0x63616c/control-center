import type { Pool, PoolClient } from "pg";
import { NotificationIdSchema } from "../../../contracts";
import { type InviteVersionId, InviteVersionIdSchema } from "../../api/src/domain-events";
import type {
  DomainTransactionContext,
  DomainTransactionRunner,
} from "../../api/src/domain-transaction";
import { id } from "../../api/src/ids";

type InviteLifecycleState =
  | { readonly kind: "eligible"; readonly expiresAt: number }
  | { readonly kind: "reminded" }
  | { readonly kind: "superseded" }
  | { readonly kind: "closed" }
  | { readonly kind: "expired" };

type Queryable = Pick<Pool | PoolClient, "query">;
type TransactionRunner = Pick<DomainTransactionRunner, "run">;

export interface InviteLifecycleStore {
  load(inviteVersionId: InviteVersionId): Promise<InviteLifecycleState>;
  requestReminder(inviteVersionId: InviteVersionId): Promise<InviteLifecycleState>;
}

type InviteRow = Readonly<{
  id: string;
  created_by: string;
  invite_expires_at: string | null;
  closed_at: string | null;
}>;

function stateFor(row: InviteRow | undefined, now: number): InviteLifecycleState {
  if (!row) return { kind: "superseded" };
  if (row.closed_at !== null) return { kind: "closed" };
  const expiresAt = row.invite_expires_at === null ? 0 : Number(row.invite_expires_at);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return { kind: "expired" };
  return { kind: "eligible", expiresAt };
}

export class PostgresInviteLifecycleStore implements InviteLifecycleStore {
  constructor(
    private readonly db: Queryable,
    private readonly transactions: TransactionRunner,
    private readonly clock: () => number = Date.now,
  ) {}

  async load(inviteVersionId: InviteVersionId): Promise<InviteLifecycleState> {
    const result = await this.db.query<InviteRow>(
      `SELECT id,created_by,invite_expires_at,closed_at
       FROM jars WHERE invite_version_id=$1`,
      [InviteVersionIdSchema.parse(inviteVersionId)],
    );
    return stateFor(result.rows[0], this.clock());
  }

  async requestReminder(inviteVersionId: InviteVersionId): Promise<InviteLifecycleState> {
    return this.transactions.run(async ({ db, emit }: DomainTransactionContext) => {
      const result = await db.query<InviteRow>(
        `SELECT id,created_by,invite_expires_at,closed_at
         FROM jars WHERE invite_version_id=$1 FOR UPDATE`,
        [InviteVersionIdSchema.parse(inviteVersionId)],
      );
      const now = this.clock();
      const current = stateFor(result.rows[0], now);
      if (current.kind !== "eligible") return current;
      const jar = result.rows[0];
      if (!jar) return { kind: "superseded" };
      const notificationId = NotificationIdSchema.parse(id("ntf"));
      const inserted = await db.query(
        `INSERT INTO user_notification
           (id,recipient_user_id,category,dedupe_key,target_type,target_id,message_key,created_at,expires_at)
         VALUES ($1,$2,'invite',$3,'jar',$4,'invite.expiring',$5,$6)
         ON CONFLICT (recipient_user_id,dedupe_key) DO NOTHING
         RETURNING id`,
        [
          notificationId,
          jar.created_by,
          `invite-expiring:${inviteVersionId}`,
          jar.id,
          now,
          current.expiresAt,
        ],
      );
      if ((inserted.rowCount ?? 0) > 0) {
        await emit({
          type: "notification.requested",
          aggregateId: notificationId,
          aggregateVersion: 1,
        });
      }
      return { kind: "reminded" };
    });
  }
}

export interface InviteLifecycleActivities {
  loadInviteLifecycle(input: {
    readonly inviteVersionId: InviteVersionId;
  }): Promise<InviteLifecycleState>;
  requestInviteReminder(input: {
    readonly inviteVersionId: InviteVersionId;
  }): Promise<InviteLifecycleState>;
}

export function createInviteLifecycleActivities(
  store: InviteLifecycleStore,
): InviteLifecycleActivities {
  return {
    loadInviteLifecycle: ({ inviteVersionId }) => store.load(inviteVersionId),
    requestInviteReminder: ({ inviteVersionId }) => store.requestReminder(inviteVersionId),
  };
}
