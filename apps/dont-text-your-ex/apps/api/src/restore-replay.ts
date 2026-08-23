import type { Pool } from "pg";
import { UserIdSchema } from "../../../contracts";
import { PostgresAccountDeletionStore } from "./account-deletion";
import type { DomainTransactionRunner } from "./domain-transaction";
import {
  type RestoreTombstoneKeyring,
  type RestoreTombstoneRecord,
  restoreUserHmac,
} from "./restore-tombstone";

type RestoredUserRow = Readonly<{ id: string }>;

export type RestoreReplayResult = Readonly<{
  activeRecords: number;
  erasedUsers: number;
  unmatchedRecords: number;
  scannedTextColumns: number;
  remainingRawReferences: 0;
}>;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Runs only against a migrated, network-isolated restored database before any
 * application traffic is enabled. Signed journal parsing happens before this
 * function; this gate matches only versioned HMACs and never persists a stable
 * deleted-user identifier.
 */
export async function replayRestoreTombstones(input: {
  readonly pool: Pick<Pool, "query">;
  readonly transactions: DomainTransactionRunner;
  readonly records: readonly RestoreTombstoneRecord[];
  readonly hmacKeys: RestoreTombstoneKeyring;
  readonly now: number;
}): Promise<RestoreReplayResult> {
  const activeRecords = input.records.filter((record) => record.expiresAt > input.now);
  const users = await input.pool.query<RestoredUserRow>("SELECT id FROM users ORDER BY id");
  const matchedRecordIds = new Set<string>();
  const matchedUserIds: string[] = [];
  let erasedUsers = 0;
  const deletions = new PostgresAccountDeletionStore(
    input.pool,
    input.transactions,
    () => input.now,
  );

  for (const row of users.rows) {
    const userId = UserIdSchema.parse(row.id);
    const matches = activeRecords.filter(
      (record) =>
        restoreUserHmac(userId, input.hmacKeys, record.hmacKeyVersion) === record.userHmac,
    );
    if (matches.length > 1) throw new Error("multiple restore tombstones match one user");
    const record = matches[0];
    if (!record) continue;
    matchedRecordIds.add(record.deletionRequestId);
    matchedUserIds.push(userId);
    await input.pool.query(
      `INSERT INTO account_deletion_request
         (id,user_id,state,created_at,updated_at)
       VALUES ($1,$2,'accepted',$3,$3)
       ON CONFLICT (id) DO NOTHING`,
      [record.deletionRequestId, userId, input.now],
    );
    await deletions.eraseLocally(record.deletionRequestId);
    erasedUsers += 1;
  }

  const remaining = await input.pool.query<RestoredUserRow>("SELECT id FROM users ORDER BY id");
  for (const row of remaining.rows) {
    const userId = UserIdSchema.parse(row.id);
    for (const record of activeRecords) {
      if (restoreUserHmac(userId, input.hmacKeys, record.hmacKeyVersion) === record.userHmac) {
        throw new Error("restore replay invariant failed: deleted user remains");
      }
    }
  }

  const textColumns = await input.pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name,column_name FROM information_schema.columns
     WHERE table_schema='public'
       AND data_type IN ('text','character varying','character')
     ORDER BY table_name,column_name`,
  );
  let remainingRawReferences = 0;
  if (matchedUserIds.length > 0) {
    for (const column of textColumns.rows) {
      const result = await input.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${quoteIdentifier(column.table_name)}
         WHERE ${quoteIdentifier(column.column_name)}=ANY($1::text[])`,
        [matchedUserIds],
      );
      remainingRawReferences += Number(result.rows[0]?.count ?? 0);
    }
  }
  if (remainingRawReferences !== 0) {
    throw new Error("restore replay invariant failed: raw user reference remains");
  }

  return {
    activeRecords: activeRecords.length,
    erasedUsers,
    unmatchedRecords: activeRecords.length - matchedRecordIds.size,
    scannedTextColumns: textColumns.rows.length,
    remainingRawReferences: 0,
  };
}
