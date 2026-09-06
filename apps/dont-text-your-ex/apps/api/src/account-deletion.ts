import type { Pool } from "pg";
import { z } from "zod";
import {
  type AccountDeletionId,
  AccountDeletionIdSchema,
  accountMutationLockKey,
  JarIdSchema,
  type UserId,
  UserIdSchema,
} from "../../../contracts";
import type { AccountDeletionCipher } from "./account-deletion-crypto";
import {
  AmbiguousDomainTransactionError,
  type DomainTransactionRunner,
} from "./domain-transaction";
import { id, inviteCode } from "./ids";
import {
  type RestoreTombstoneRecord,
  RestoreTombstoneRecordSchema,
  type RestoreTombstoneService,
} from "./restore-tombstone";

export {
  type AccountDeletionCipher,
  createAccountDeletionCipher,
  parseAccountDeletionKeyring,
} from "./account-deletion-crypto";

export const ACCOUNT_DELETION_STATE = {
  Accepted: "accepted",
  Erasing: "erasing",
  LocallyErased: "locally_erased",
  AppleRevocationPending: "apple_revocation_pending",
  Complete: "complete",
  ManualActionRequired: "manual_action_required",
} as const;
type AccountDeletionState = (typeof ACCOUNT_DELETION_STATE)[keyof typeof ACCOUNT_DELETION_STATE];
const accountDeletionStateSchema = z.enum(ACCOUNT_DELETION_STATE);

export const ACCOUNT_DELETION_CLEANUP_STATE = {
  Pending: "pending",
  Terminated: "terminated",
  Deleted: "deleted",
} as const;
export type AccountDeletionCleanupState =
  (typeof ACCOUNT_DELETION_CLEANUP_STATE)[keyof typeof ACCOUNT_DELETION_CLEANUP_STATE];
export type TerminalAccountDeletionState =
  | typeof ACCOUNT_DELETION_STATE.Complete
  | typeof ACCOUNT_DELETION_STATE.ManualActionRequired;
const POST_ERASURE_STATES: ReadonlySet<AccountDeletionState> = new Set([
  ACCOUNT_DELETION_STATE.LocallyErased,
  ACCOUNT_DELETION_STATE.AppleRevocationPending,
  ACCOUNT_DELETION_STATE.Complete,
  ACCOUNT_DELETION_STATE.ManualActionRequired,
]);

export type AccountDeletionReceipt = Readonly<{
  status: typeof ACCOUNT_DELETION_STATE.Accepted;
  deletionRequestId: AccountDeletionId;
}>;

export type AccountDeletionRecord = Readonly<{
  id: AccountDeletionId;
  state: AccountDeletionState;
}>;

export type TerminalDeletionWorkflow = Readonly<{
  deletionRequestId: AccountDeletionId;
  workflowId: string;
}>;

const deletionRowSchema = z.object({
  id: AccountDeletionIdSchema,
  state: accountDeletionStateSchema,
});

const deletionCredentialRowSchema = z.object({
  authorization_code_ciphertext: z.string().nullable(),
  authorization_code_nonce: z.string().nullable(),
  authorization_code_key_id: z.string().nullable(),
  apple_subject_ciphertext: z.string().nullable().optional(),
  apple_subject_nonce: z.string().nullable().optional(),
  apple_subject_key_id: z.string().nullable().optional(),
  refresh_token_ciphertext: z.string().nullable().optional(),
  refresh_token_nonce: z.string().nullable().optional(),
  refresh_token_key_id: z.string().nullable().optional(),
});

const erasureRequestRowSchema = z.object({
  user_id: UserIdSchema.nullable(),
  state: accountDeletionStateSchema,
});
const terminalDeletionWorkflowRowSchema = z.object({
  deletion_request_id: AccountDeletionIdSchema,
  workflow_id: z.string(),
});

const erasureJarRowSchema = z.object({
  id: JarIdSchema,
  created_by: UserIdSchema.nullable(),
  closed_at: z.string().nullable(),
  departing_role: z.enum(["owner", "member"]).nullable(),
  departing_left_at: z.string().nullable(),
});

const activeMemberRowSchema = z.object({
  id: z.string().min(1),
  user_id: UserIdSchema,
});
const erasureUserRowSchema = z.object({ id: UserIdSchema, phone: z.string().nullable() });

const restoreTombstoneRowSchema = z.object({
  deletion_request_id: AccountDeletionIdSchema,
  user_hmac: z.string(),
  key_version: z.string(),
  signature: z.string(),
  signature_key_version: z.string(),
  completed_at: z.string().nullable(),
  expires_at: z.string(),
});
function parseTombstoneRow(input: unknown): RestoreTombstoneRecord {
  const row = restoreTombstoneRowSchema.parse(input);
  return RestoreTombstoneRecordSchema.parse({
    schemaVersion: 1,
    deletionRequestId: row.deletion_request_id,
    userHmac: row.user_hmac,
    hmacKeyVersion: row.key_version,
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    expiresAt: Number(row.expires_at),
    signatureVersion: 1,
    signatureKeyVersion: row.signature_key_version,
    signature: row.signature,
  });
}

function authorizationCodeContext(deletionRequestId: AccountDeletionId): string {
  return `deletion/${deletionRequestId}/authorization-code`;
}

function refreshTokenContext(deletionRequestId: AccountDeletionId): string {
  return `deletion/${deletionRequestId}/refresh-token`;
}

function appleSubjectContext(deletionRequestId: AccountDeletionId): string {
  return `deletion/${deletionRequestId}/apple-subject`;
}

export { accountMutationLockKey } from "../../../contracts";

class AccountDeletionUserNotFoundError extends Error {
  constructor() {
    super("account deletion user not found");
  }
}

export class PostgresAccountDeletionStore {
  constructor(
    private readonly pool: Pick<Pool, "query">,
    private readonly transactions: DomainTransactionRunner,
    private readonly clock: () => number = Date.now,
    private readonly cipher?: AccountDeletionCipher,
    private readonly tombstones?: RestoreTombstoneService,
  ) {}

  async request(
    input: Readonly<
      { userId: UserId } & (
        | { authorizationCode: string; appleSubject: string }
        | { authorizationCode?: never; appleSubject?: never }
      )
    >,
  ): Promise<AccountDeletionReceipt> {
    let tombstoneToPublish: RestoreTombstoneRecord | undefined;
    let stagedTombstone: RestoreTombstoneRecord | undefined;
    let receipt: AccountDeletionReceipt;
    try {
      receipt = await this.transactions.run(async ({ db, emit }) => {
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          accountMutationLockKey(input.userId),
        ]);
        const user = await db.query<{ deletion_requested_at: string | null }>(
          "SELECT deletion_requested_at FROM users WHERE id=$1 FOR UPDATE",
          [input.userId],
        );
        if (!user.rows[0]) throw new AccountDeletionUserNotFoundError();

        const existing = await db.query<Record<string, unknown>>(
          "SELECT id,state FROM account_deletion_request WHERE user_id=$1",
          [input.userId],
        );
        if (existing.rows[0]) {
          const row = deletionRowSchema.parse(existing.rows[0]);
          if (this.tombstones) {
            const persisted = await db.query<Record<string, unknown>>(
              `SELECT deletion_request_id,user_hmac,key_version,signature,
                      signature_key_version,completed_at,expires_at
               FROM deletion_restore_tombstone WHERE deletion_request_id=$1`,
              [row.id],
            );
            if (persisted.rows[0]) tombstoneToPublish = parseTombstoneRow(persisted.rows[0]);
          }
          return { status: ACCOUNT_DELETION_STATE.Accepted, deletionRequestId: row.id };
        }

        const deletionRequestId = id("del");
        const requestedAt = this.clock();
        const sealedAuthorizationCode = input.authorizationCode
          ? this.cipher?.seal(input.authorizationCode, authorizationCodeContext(deletionRequestId))
          : undefined;
        const sealedAppleSubject = input.appleSubject
          ? this.cipher?.seal(input.appleSubject, appleSubjectContext(deletionRequestId))
          : undefined;
        if (input.authorizationCode && (!sealedAuthorizationCode || !sealedAppleSubject)) {
          throw new Error("account deletion credential protection is not configured");
        }
        await db.query(
          `INSERT INTO account_deletion_request
           (id,user_id,state,authorization_code_ciphertext,
            authorization_code_nonce,authorization_code_key_id,
            apple_subject_ciphertext,apple_subject_nonce,apple_subject_key_id,
            created_at,updated_at)
         VALUES ($1,$2,'accepted',$3,$4,$5,$6,$7,$8,$9,$9)`,
          [
            deletionRequestId,
            input.userId,
            sealedAuthorizationCode?.ciphertext ?? null,
            sealedAuthorizationCode?.nonce ?? null,
            sealedAuthorizationCode?.keyId ?? null,
            sealedAppleSubject?.ciphertext ?? null,
            sealedAppleSubject?.nonce ?? null,
            sealedAppleSubject?.keyId ?? null,
            requestedAt,
          ],
        );
        await db.query(
          `WITH affected_reports(id) AS (
           SELECT id FROM reports WHERE accuser_id=$2 OR accused_id=$2
         ), affected_activity(id) AS (
           SELECT id FROM activity
           WHERE actor_id=$2 OR target_id=$2 OR report_id IN (SELECT id FROM affected_reports)
         ), affected_jars(id) AS (
           SELECT j.id
           FROM jars j
           LEFT JOIN memberships m ON m.jar_id=j.id AND m.user_id=$2
           WHERE j.created_by=$2 OR m.id IS NOT NULL
         ), associated(workflow_id) AS (
           SELECT 'deletion/' || $1
           UNION
           SELECT 'rescue/' || id FROM rescue_interventions WHERE user_id=$2
           UNION
           SELECT 'report/' || id FROM affected_reports
           UNION
           SELECT 'notification/' || n.id FROM user_notification n
           WHERE n.recipient_user_id=$2
              OR (n.target_type='profile' AND n.target_id=$2)
              OR (n.target_type='report' AND n.target_id IN (SELECT id FROM affected_reports))
              OR (n.target_type='activity' AND n.target_id IN (SELECT id FROM affected_activity))
           UNION
           SELECT 'invite/' || v.invite_version_id
           FROM jar_invite_version v
           WHERE v.jar_id IN (SELECT id FROM affected_jars)
         )
         INSERT INTO account_deletion_cleanup_item
           (deletion_request_id,workflow_id,state,updated_at)
         SELECT $1,workflow_id,'pending',$3
         FROM associated`,
          [deletionRequestId, input.userId, requestedAt],
        );
        if (this.tombstones) {
          const tombstone = this.tombstones.prepare({
            deletionRequestId,
            userId: input.userId,
            createdAt: requestedAt,
          });
          await db.query(
            `INSERT INTO deletion_restore_tombstone
             (deletion_request_id,user_hmac,key_version,signature,
              signature_key_version,journal_published_at,completed_at,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              deletionRequestId,
              tombstone.userHmac,
              tombstone.hmacKeyVersion,
              tombstone.signature,
              tombstone.signatureKeyVersion,
              requestedAt,
              tombstone.completedAt,
              tombstone.expiresAt,
            ],
          );
          stagedTombstone = tombstone;
          await this.tombstones.stageIntent(tombstone);
          tombstoneToPublish = tombstone;
        }
        await db.query("UPDATE users SET deletion_requested_at=$2 WHERE id=$1", [
          input.userId,
          requestedAt,
        ]);
        await db.query("DELETE FROM sessions WHERE user_id=$1", [input.userId]);
        await db.query(
          `UPDATE push_device
         SET active=FALSE, disabled_at=COALESCE(disabled_at,$2)
         WHERE user_id=$1 AND active=TRUE`,
          [input.userId, requestedAt],
        );
        await db.query(
          `UPDATE notification_delivery
         SET status='suppressed', updated_at=$2
         WHERE status='pending' AND notification_id IN (
           SELECT n.id FROM user_notification n
           WHERE n.recipient_user_id=$1
              OR (n.target_type='profile' AND n.target_id=$1)
              OR (n.target_type='report' AND n.target_id IN (
                SELECT id FROM reports WHERE accuser_id=$1 OR accused_id=$1
              ))
              OR (n.target_type='activity' AND n.target_id IN (
                SELECT id FROM activity
                WHERE actor_id=$1 OR target_id=$1 OR report_id IN (
                  SELECT id FROM reports WHERE accuser_id=$1 OR accused_id=$1
                )
              ))
         )`,
          [input.userId, requestedAt],
        );
        await emit({
          type: "account.deletion_requested",
          aggregateId: deletionRequestId,
          aggregateVersion: 1,
        });
        return { status: ACCOUNT_DELETION_STATE.Accepted, deletionRequestId };
      });
    } catch (error) {
      if (
        stagedTombstone &&
        this.tombstones &&
        !(error instanceof AmbiguousDomainTransactionError)
      ) {
        try {
          await this.tombstones.discardIntent(stagedTombstone);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "account deletion failed and its staged restore record could not be removed",
          );
        }
      }
      throw error;
    }
    if (tombstoneToPublish && this.tombstones) {
      await this.tombstones.publish(tombstoneToPublish);
    }
    return receipt;
  }

  async load(deletionRequestId: AccountDeletionId): Promise<AccountDeletionRecord | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      "SELECT id,state FROM account_deletion_request WHERE id=$1",
      [deletionRequestId],
    );
    return result.rows[0] ? deletionRowSchema.parse(result.rows[0]) : null;
  }

  async loadAppleRevocationCredential(
    deletionRequestId: AccountDeletionId,
  ): Promise<{ readonly authorizationCode: string; readonly expectedSubject: string } | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT authorization_code_ciphertext,authorization_code_nonce,authorization_code_key_id,
              apple_subject_ciphertext,apple_subject_nonce,apple_subject_key_id
       FROM account_deletion_request WHERE id=$1`,
      [deletionRequestId],
    );
    const rawRow = result.rows[0];
    if (!rawRow) return null;
    const row = deletionCredentialRowSchema.parse(rawRow);
    if (!row.authorization_code_ciphertext) return null;
    if (
      !row.authorization_code_nonce ||
      !row.authorization_code_key_id ||
      !row.apple_subject_ciphertext ||
      !row.apple_subject_nonce ||
      !row.apple_subject_key_id ||
      !this.cipher
    ) {
      throw new Error("account deletion credential protection is not configured");
    }
    return {
      authorizationCode: this.cipher.open(
        {
          ciphertext: row.authorization_code_ciphertext,
          nonce: row.authorization_code_nonce,
          keyId: row.authorization_code_key_id,
        },
        authorizationCodeContext(deletionRequestId),
      ),
      expectedSubject: this.cipher.open(
        {
          ciphertext: row.apple_subject_ciphertext,
          nonce: row.apple_subject_nonce,
          keyId: row.apple_subject_key_id,
        },
        appleSubjectContext(deletionRequestId),
      ),
    };
  }

  async saveRefreshToken(
    deletionRequestId: AccountDeletionId,
    refreshToken: string,
  ): Promise<void> {
    if (!this.cipher) throw new Error("account deletion credential protection is not configured");
    const sealed = this.cipher.seal(refreshToken, refreshTokenContext(deletionRequestId));
    const result = await this.pool.query(
      `UPDATE account_deletion_request
       SET state='apple_revocation_pending',
           refresh_token_ciphertext=$2,refresh_token_nonce=$3,refresh_token_key_id=$4,
           authorization_code_ciphertext=NULL,authorization_code_nonce=NULL,
           authorization_code_key_id=NULL,apple_subject_ciphertext=NULL,
           apple_subject_nonce=NULL,apple_subject_key_id=NULL,updated_at=$5
       WHERE id=$1 AND state NOT IN ('complete','manual_action_required')`,
      [deletionRequestId, sealed.ciphertext, sealed.nonce, sealed.keyId, this.clock()],
    );
    if (result.rowCount !== 1)
      throw new Error("account deletion request cannot accept refresh token");
  }

  async loadRefreshToken(deletionRequestId: AccountDeletionId): Promise<string | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT authorization_code_ciphertext,authorization_code_nonce,authorization_code_key_id,
              refresh_token_ciphertext,refresh_token_nonce,refresh_token_key_id
       FROM account_deletion_request WHERE id=$1`,
      [deletionRequestId],
    );
    const rawRow = result.rows[0];
    if (!rawRow) return null;
    const row = deletionCredentialRowSchema.parse(rawRow);
    if (!row.refresh_token_ciphertext) return null;
    if (!row.refresh_token_nonce || !row.refresh_token_key_id || !this.cipher) {
      throw new Error("account deletion credential protection is not configured");
    }
    return this.cipher.open(
      {
        ciphertext: row.refresh_token_ciphertext,
        nonce: row.refresh_token_nonce,
        keyId: row.refresh_token_key_id,
      },
      refreshTokenContext(deletionRequestId),
    );
  }

  async markTerminal(
    deletionRequestId: AccountDeletionId,
    state: TerminalAccountDeletionState,
  ): Promise<void> {
    await this.transactions.run(async ({ db }) => {
      const existing = await db.query<Record<string, unknown>>(
        "SELECT id,state FROM account_deletion_request WHERE id=$1 FOR UPDATE",
        [deletionRequestId],
      );
      const rawCurrent = existing.rows[0];
      if (!rawCurrent) throw new Error("account deletion request not found");
      const current = deletionRowSchema.parse(rawCurrent);
      if (
        current.state === ACCOUNT_DELETION_STATE.Complete ||
        current.state === ACCOUNT_DELETION_STATE.ManualActionRequired
      ) {
        if (current.state !== state) {
          throw new Error("conflicting terminal account deletion state");
        }
      } else {
        const terminalAt = this.clock();
        await db.query(
          `UPDATE account_deletion_request
           SET state=$2,aggregate_version=aggregate_version+1,
               authorization_code_ciphertext=NULL,authorization_code_nonce=NULL,
               authorization_code_key_id=NULL,apple_subject_ciphertext=NULL,
               apple_subject_nonce=NULL,apple_subject_key_id=NULL,refresh_token_ciphertext=NULL,
               refresh_token_nonce=NULL,refresh_token_key_id=NULL,
               updated_at=$3,terminal_at=COALESCE(terminal_at,$3)
           WHERE id=$1`,
          [deletionRequestId, state, terminalAt],
        );
      }
      await db.query(
        "DELETE FROM domain_event WHERE aggregate_type='account_deletion' AND aggregate_id=$1",
        [deletionRequestId],
      );
    });
  }

  async listAssociatedWorkflowIds(
    deletionRequestId: AccountDeletionId,
    states: readonly AccountDeletionCleanupState[],
  ): Promise<readonly string[]> {
    if (states.length === 0) return [];
    const result = await this.pool.query<{ workflow_id: string }>(
      `SELECT workflow_id FROM account_deletion_cleanup_item
       WHERE deletion_request_id=$1 AND state=ANY($2::text[])
         AND workflow_id<>('deletion/' || $1)
       ORDER BY workflow_id`,
      [deletionRequestId, states],
    );
    return result.rows.map((row) => row.workflow_id);
  }

  async markCleanupState(
    deletionRequestId: AccountDeletionId,
    workflowId: string,
    state: AccountDeletionCleanupState,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE account_deletion_cleanup_item SET state=$3,updated_at=$4
       WHERE deletion_request_id=$1 AND workflow_id=$2`,
      [deletionRequestId, workflowId, state, this.clock()],
    );
    if (result.rowCount !== 1) throw new Error("account deletion cleanup item not found");
  }

  async listTerminalDeletionWorkflows(
    terminalBefore: number,
    limit: number,
  ): Promise<readonly TerminalDeletionWorkflow[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT c.deletion_request_id,c.workflow_id
       FROM account_deletion_cleanup_item c
       JOIN account_deletion_request r ON r.id=c.deletion_request_id
       WHERE r.state IN ('complete','manual_action_required')
         AND r.terminal_at<=$1 AND c.state<>'deleted'
         AND c.workflow_id=('deletion/' || c.deletion_request_id)
         AND NOT EXISTS (
           SELECT 1 FROM account_deletion_cleanup_item associated
           WHERE associated.deletion_request_id=c.deletion_request_id
             AND associated.workflow_id<>c.workflow_id
             AND associated.state<>'deleted'
         )
       ORDER BY r.terminal_at,c.deletion_request_id LIMIT $2`,
      [terminalBefore, limit],
    );
    return result.rows.map((input) => {
      const row = terminalDeletionWorkflowRowSchema.parse(input);
      return { deletionRequestId: row.deletion_request_id, workflowId: row.workflow_id };
    });
  }

  async purgeExpiredRecords(
    expiredBefore: number,
    limit: number,
  ): Promise<{ readonly deleted: number }> {
    if (!this.tombstones) throw new Error("restore tombstone cleanup is not configured");
    const candidates = await this.pool.query<Record<string, unknown>>(
      `SELECT t.deletion_request_id,t.user_hmac,t.key_version,t.signature,
              t.signature_key_version,t.completed_at,t.expires_at
       FROM deletion_restore_tombstone t
       JOIN account_deletion_request r ON r.id=t.deletion_request_id
       WHERE t.expires_at<=$1
         AND r.state IN ('complete','manual_action_required')
         AND NOT EXISTS (
           SELECT 1 FROM account_deletion_cleanup_item c
           WHERE c.deletion_request_id=t.deletion_request_id AND c.state<>'deleted'
         )
       ORDER BY t.expires_at,t.deletion_request_id LIMIT $2`,
      [expiredBefore, limit],
    );
    let deleted = 0;
    for (const input of candidates.rows) {
      const candidate = restoreTombstoneRowSchema.parse(input);
      await this.tombstones.remove(parseTombstoneRow(candidate));
      const result = await this.pool.query(
        `DELETE FROM account_deletion_request r
         WHERE r.id=$1 AND r.state IN ('complete','manual_action_required')
           AND EXISTS (
             SELECT 1 FROM deletion_restore_tombstone t
             WHERE t.deletion_request_id=r.id AND t.expires_at<=$2
           )
           AND NOT EXISTS (
             SELECT 1 FROM account_deletion_cleanup_item c
             WHERE c.deletion_request_id=r.id AND c.state<>'deleted'
           )`,
        [candidate.deletion_request_id, expiredBefore],
      );
      deleted += result.rowCount ?? 0;
    }
    return { deleted };
  }

  async eraseLocally(deletionRequestId: AccountDeletionId): Promise<void> {
    let rollbackTombstone: RestoreTombstoneRecord | undefined;
    try {
      await this.transactions.run(async ({ db }) => {
        const request = await db.query<Record<string, unknown>>(
          "SELECT user_id,state FROM account_deletion_request WHERE id=$1 FOR UPDATE",
          [deletionRequestId],
        );
        const rawRow = request.rows[0];
        if (!rawRow) throw new Error("account deletion request not found");
        const row = erasureRequestRowSchema.parse(rawRow);
        if (POST_ERASURE_STATES.has(row.state)) {
          return;
        }
        if (!row.user_id) throw new Error("account deletion request has no user to erase");
        const userId = row.user_id;
        const erasedAt = this.clock();

        await db.query(
          "UPDATE account_deletion_request SET state='erasing',updated_at=$2 WHERE id=$1",
          [deletionRequestId, erasedAt],
        );
        const user = await db.query<Record<string, unknown>>(
          "SELECT id,phone FROM users WHERE id=$1 FOR UPDATE",
          [userId],
        );
        const rawUserRow = user.rows[0];
        if (!rawUserRow) throw new Error("account deletion user disappeared before erasure");
        const userRow = erasureUserRowSchema.parse(rawUserRow);

        const jars = await db.query<Record<string, unknown>>(
          `SELECT j.id,j.created_by,j.closed_at,
                departing.role AS departing_role,departing.left_at AS departing_left_at
         FROM jars j
         LEFT JOIN memberships departing
           ON departing.jar_id=j.id AND departing.user_id=$1
         WHERE j.created_by=$1 OR departing.id IS NOT NULL
         ORDER BY j.id
         FOR UPDATE OF j`,
          [userId],
        );
        await db.query(
          `SELECT id FROM reports
           WHERE accuser_id=$1 OR accused_id=$1 ORDER BY id FOR UPDATE`,
          [userId],
        );
        await db.query(
          "SELECT id FROM rescue_interventions WHERE user_id=$1 ORDER BY id FOR UPDATE",
          [userId],
        );
        await db.query(
          `WITH affected_reports(id) AS (
             SELECT id FROM reports WHERE accuser_id=$2 OR accused_id=$2
           ), affected_activity(id) AS (
             SELECT id FROM activity
             WHERE actor_id=$2 OR target_id=$2 OR report_id IN (SELECT id FROM affected_reports)
           ), affected_jars(id) AS (
             SELECT j.id
             FROM jars j
             LEFT JOIN memberships m ON m.jar_id=j.id AND m.user_id=$2
             WHERE j.created_by=$2 OR m.id IS NOT NULL
           ), associated(workflow_id) AS (
             SELECT 'rescue/' || id FROM rescue_interventions WHERE user_id=$2
             UNION
             SELECT 'report/' || id FROM affected_reports
             UNION
             SELECT 'notification/' || n.id FROM user_notification n
             WHERE n.recipient_user_id=$2
                OR (n.target_type='profile' AND n.target_id=$2)
                OR (n.target_type='report' AND n.target_id IN (SELECT id FROM affected_reports))
                OR (n.target_type='activity' AND n.target_id IN (SELECT id FROM affected_activity))
             UNION
             SELECT 'invite/' || v.invite_version_id
             FROM jar_invite_version v
             WHERE v.jar_id IN (SELECT id FROM affected_jars)
           )
           INSERT INTO account_deletion_cleanup_item
             (deletion_request_id,workflow_id,state,updated_at)
           SELECT $1,workflow_id,'pending',$3
           FROM associated
           ON CONFLICT (deletion_request_id,workflow_id) DO NOTHING`,
          [deletionRequestId, userId, erasedAt],
        );
        for (const input of jars.rows) {
          const jar = erasureJarRowSchema.parse(input);
          const activeResult = await db.query<Record<string, unknown>>(
            `SELECT id,user_id FROM memberships
           WHERE jar_id=$1 AND user_id<>$2 AND left_at IS NULL
           ORDER BY joined_at,id FOR UPDATE`,
            [jar.id, userId],
          );
          const active = activeResult.rows.map((row) => activeMemberRowSchema.parse(row));
          const departingWasActive = jar.departing_role !== null && jar.departing_left_at === null;
          if (active.length === 0 && (jar.created_by === userId || departingWasActive)) {
            await db.query("DELETE FROM jars WHERE id=$1", [jar.id]);
            continue;
          }

          const creatorIsDeparting = jar.created_by === userId;
          const ownerIsDeparting = departingWasActive && jar.departing_role === "owner";
          if ((creatorIsDeparting || ownerIsDeparting) && active[0]) {
            await db.query(
              "UPDATE memberships SET role='member' WHERE jar_id=$1 AND left_at IS NULL AND user_id<>$2",
              [jar.id, userId],
            );
            await db.query("UPDATE memberships SET role='owner' WHERE id=$1", [active[0].id]);
          }

          await db.query(
            `UPDATE jars
           SET name=CASE WHEN created_by=$2 THEN 'Shared jar' ELSE name END,
               rule=CASE WHEN created_by=$2 THEN '' ELSE rule END,
               created_by=CASE WHEN created_by=$2 THEN NULL ELSE created_by END,
               closed_by=CASE WHEN closed_by=$2 THEN NULL ELSE closed_by END,
               invite_code=CASE WHEN closed_at IS NULL THEN $3 ELSE invite_code END,
               invite_expires_at=CASE WHEN closed_at IS NULL THEN $4 ELSE invite_expires_at END,
               invite_version_id=CASE WHEN closed_at IS NULL THEN $5 ELSE invite_version_id END
           WHERE id=$1`,
            [jar.id, userId, inviteCode(), erasedAt + 7 * 24 * 60 * 60 * 1000, id("inv")],
          );
        }

        await db.query(
          `DELETE FROM user_notification n
         WHERE n.recipient_user_id=$1
            OR (n.target_type='profile' AND n.target_id=$1)
            OR (n.target_type='report' AND n.target_id IN (
              SELECT id FROM reports WHERE accuser_id=$1 OR accused_id=$1
            ))
            OR (n.target_type='activity' AND n.target_id IN (
              SELECT id FROM activity
              WHERE actor_id=$1 OR target_id=$1 OR report_id IN (
                SELECT id FROM reports WHERE accuser_id=$1 OR accused_id=$1
              )
            ))`,
          [userId],
        );
        await db.query(
          `DELETE FROM activity
         WHERE actor_id=$1 OR target_id=$1 OR report_id IN (
           SELECT id FROM reports WHERE accuser_id=$1 OR accused_id=$1
         )`,
          [userId],
        );
        await db.query("DELETE FROM reports WHERE accuser_id=$1 OR accused_id=$1", [userId]);
        await db.query("DELETE FROM slips WHERE user_id=$1", [userId]);
        await db.query(
          `UPDATE slips
         SET reported_by=NULL,note=NULL,ex_label=NULL,source='system'
         WHERE reported_by=$1`,
          [userId],
        );
        if (userRow.phone) await db.query("DELETE FROM otps WHERE phone=$1", [userRow.phone]);
        await db.query(
          `DELETE FROM domain_event
         WHERE aggregate_id IN (
           SELECT split_part(workflow_id,'/',2)
           FROM account_deletion_cleanup_item
           WHERE deletion_request_id=$1 AND workflow_id NOT LIKE 'deletion/%'
         )`,
          [deletionRequestId],
        );
        await db.query("DELETE FROM users WHERE id=$1", [userId]);
        if (this.tombstones) {
          const tombstoneResult = await db.query<Record<string, unknown>>(
            `SELECT deletion_request_id,user_hmac,key_version,signature,
                  signature_key_version,completed_at,expires_at
           FROM deletion_restore_tombstone WHERE deletion_request_id=$1 FOR UPDATE`,
            [deletionRequestId],
          );
          const pending = tombstoneResult.rows[0];
          if (!pending) throw new Error("restore tombstone is missing");
          const completed = this.tombstones.complete(parseTombstoneRow(pending), erasedAt);
          await db.query(
            `UPDATE deletion_restore_tombstone
           SET signature=$2,signature_key_version=$3,journal_published_at=$4,
               completed_at=$4,expires_at=$5
           WHERE deletion_request_id=$1`,
            [
              deletionRequestId,
              completed.signature,
              completed.signatureKeyVersion,
              erasedAt,
              completed.expiresAt,
            ],
          );
          await this.tombstones.publish(completed);
          rollbackTombstone = parseTombstoneRow(pending);
        }
        await db.query(
          `UPDATE account_deletion_request
         SET state='locally_erased',aggregate_version=aggregate_version+1,
             updated_at=$2,locally_erased_at=$2
         WHERE id=$1`,
          [deletionRequestId, erasedAt],
        );
      });
    } catch (error) {
      if (rollbackTombstone && this.tombstones) {
        const committed = await this.pool
          .query<Record<string, unknown>>(
            "SELECT id,state FROM account_deletion_request WHERE id=$1",
            [deletionRequestId],
          )
          .catch(() => undefined);
        if (
          committed?.rows[0] &&
          !POST_ERASURE_STATES.has(deletionRowSchema.parse(committed.rows[0]).state)
        ) {
          await this.tombstones.publish(rollbackTombstone);
        }
      }
      throw error;
    }
  }
}
