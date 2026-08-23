import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import type { AccountDeletionId, UserId } from "../../../contracts";
import type { DomainTransactionRunner } from "./domain-transaction";
import { id, inviteCode } from "./ids";

const encodedDeletionKeySchema = z.string().transform((value, context) => {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    context.addIssue({ code: "custom", message: "account deletion keys must be 32 bytes" });
    return z.NEVER;
  }
  return key;
});
const deletionKeyringSchema = z
  .object({
    activeKeyId: z.string().min(1),
    keys: z.record(z.string().min(1), encodedDeletionKeySchema),
  })
  .strict();

export type AccountDeletionKeyring = Readonly<{
  activeKeyId: string;
  keys: Readonly<Record<string, Buffer>>;
}>;
export type SealedAccountDeletionCredential = Readonly<{
  keyId: string;
  nonce: string;
  ciphertext: string;
}>;
export interface AccountDeletionCipher {
  seal(value: string, context: string): SealedAccountDeletionCredential;
  open(sealed: SealedAccountDeletionCredential, context: string): string;
}

export function parseAccountDeletionKeyring(input: unknown): AccountDeletionKeyring {
  const parsed = deletionKeyringSchema.parse(input);
  if (!parsed.keys[parsed.activeKeyId]) {
    throw new Error("active account deletion key is missing");
  }
  return parsed;
}

export function createAccountDeletionCipher(
  keyring: AccountDeletionKeyring,
): AccountDeletionCipher {
  return {
    seal(value, context) {
      const nonce = randomBytes(12);
      const key = keyring.keys[keyring.activeKeyId];
      if (!key) throw new Error("active account deletion key is missing");
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return {
        keyId: keyring.activeKeyId,
        nonce: nonce.toString("base64"),
        ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"),
      };
    },
    open(sealed, context) {
      try {
        const key = keyring.keys[sealed.keyId];
        if (!key) throw new Error("key unavailable");
        const payload = Buffer.from(sealed.ciphertext, "base64");
        if (payload.length < 17) throw new Error("ciphertext malformed");
        const body = payload.subarray(0, payload.length - 16);
        const tag = payload.subarray(payload.length - 16);
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce, "base64"));
        decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
      } catch {
        throw new Error("account deletion credential could not be decrypted");
      }
    },
  };
}

export type AccountDeletionState =
  | "accepted"
  | "erasing"
  | "locally_erased"
  | "apple_revocation_pending"
  | "complete"
  | "manual_action_required";

export type AccountDeletionReceipt = Readonly<{
  status: "accepted";
  deletionRequestId: AccountDeletionId;
}>;

export type AccountDeletionRecord = Readonly<{
  id: AccountDeletionId;
  state: AccountDeletionState;
}>;

type DeletionRow = {
  readonly id: AccountDeletionId;
  readonly state: AccountDeletionState;
};

type DeletionCredentialRow = {
  readonly authorization_code_ciphertext: string | null;
  readonly authorization_code_nonce: string | null;
  readonly authorization_code_key_id: string | null;
  readonly refresh_token_ciphertext?: string | null;
  readonly refresh_token_nonce?: string | null;
  readonly refresh_token_key_id?: string | null;
};

type ErasureRequestRow = {
  readonly user_id: string | null;
  readonly state: AccountDeletionState;
};

type ErasureJarRow = {
  readonly id: string;
  readonly created_by: string | null;
  readonly closed_at: string | null;
  readonly departing_role: string | null;
  readonly departing_left_at: string | null;
};

type ActiveMemberRow = {
  readonly id: string;
  readonly user_id: string;
};

function authorizationCodeContext(deletionRequestId: AccountDeletionId): string {
  return `deletion/${deletionRequestId}/authorization-code`;
}

function refreshTokenContext(deletionRequestId: AccountDeletionId): string {
  return `deletion/${deletionRequestId}/refresh-token`;
}

export class AccountDeletionUserNotFoundError extends Error {
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
  ) {}

  async request(
    input: Readonly<{ userId: UserId; authorizationCode?: string }>,
  ): Promise<AccountDeletionReceipt> {
    return this.transactions.run(async ({ db, emit }) => {
      const user = await db.query<{ deletion_requested_at: string | null }>(
        "SELECT deletion_requested_at FROM users WHERE id=$1 FOR UPDATE",
        [input.userId],
      );
      if (!user.rows[0]) throw new AccountDeletionUserNotFoundError();

      const existing = await db.query<DeletionRow>(
        "SELECT id,state FROM account_deletion_request WHERE user_id=$1",
        [input.userId],
      );
      if (existing.rows[0]) {
        return { status: "accepted", deletionRequestId: existing.rows[0].id };
      }

      const deletionRequestId = id("del");
      const requestedAt = this.clock();
      const sealedAuthorizationCode = input.authorizationCode
        ? this.cipher?.seal(input.authorizationCode, authorizationCodeContext(deletionRequestId))
        : undefined;
      if (input.authorizationCode && !sealedAuthorizationCode) {
        throw new Error("account deletion credential protection is not configured");
      }
      await db.query(
        `INSERT INTO account_deletion_request
           (id,user_id,state,authorization_code_ciphertext,
            authorization_code_nonce,authorization_code_key_id,created_at,updated_at)
         VALUES ($1,$2,'accepted',$3,$4,$5,$6,$6)`,
        [
          deletionRequestId,
          input.userId,
          sealedAuthorizationCode?.ciphertext ?? null,
          sealedAuthorizationCode?.nonce ?? null,
          sealedAuthorizationCode?.keyId ?? null,
          requestedAt,
        ],
      );
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
           SELECT id FROM user_notification WHERE recipient_user_id=$1
         )`,
        [input.userId, requestedAt],
      );
      await emit({
        type: "account.deletion_requested",
        aggregateId: deletionRequestId,
        aggregateVersion: 1,
      });
      return { status: "accepted", deletionRequestId };
    });
  }

  async load(deletionRequestId: AccountDeletionId): Promise<AccountDeletionRecord | null> {
    const result = await this.pool.query<DeletionRow>(
      "SELECT id,state FROM account_deletion_request WHERE id=$1",
      [deletionRequestId],
    );
    return result.rows[0] ?? null;
  }

  async loadAuthorizationCode(deletionRequestId: AccountDeletionId): Promise<string | null> {
    const result = await this.pool.query<DeletionCredentialRow>(
      `SELECT authorization_code_ciphertext,authorization_code_nonce,authorization_code_key_id
       FROM account_deletion_request WHERE id=$1`,
      [deletionRequestId],
    );
    const row = result.rows[0];
    if (!row?.authorization_code_ciphertext) return null;
    if (!row.authorization_code_nonce || !row.authorization_code_key_id || !this.cipher) {
      throw new Error("account deletion credential protection is not configured");
    }
    return this.cipher.open(
      {
        ciphertext: row.authorization_code_ciphertext,
        nonce: row.authorization_code_nonce,
        keyId: row.authorization_code_key_id,
      },
      authorizationCodeContext(deletionRequestId),
    );
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
           authorization_code_key_id=NULL,updated_at=$5
       WHERE id=$1 AND state NOT IN ('complete','manual_action_required')`,
      [deletionRequestId, sealed.ciphertext, sealed.nonce, sealed.keyId, this.clock()],
    );
    if (result.rowCount !== 1)
      throw new Error("account deletion request cannot accept refresh token");
  }

  async loadRefreshToken(deletionRequestId: AccountDeletionId): Promise<string | null> {
    const result = await this.pool.query<DeletionCredentialRow>(
      `SELECT authorization_code_ciphertext,authorization_code_nonce,authorization_code_key_id,
              refresh_token_ciphertext,refresh_token_nonce,refresh_token_key_id
       FROM account_deletion_request WHERE id=$1`,
      [deletionRequestId],
    );
    const row = result.rows[0];
    if (!row?.refresh_token_ciphertext) return null;
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
    state: "complete" | "manual_action_required",
  ): Promise<void> {
    const terminalAt = this.clock();
    const result = await this.pool.query(
      `UPDATE account_deletion_request
       SET state=$2,aggregate_version=aggregate_version+1,
           authorization_code_ciphertext=NULL,authorization_code_nonce=NULL,
           authorization_code_key_id=NULL,refresh_token_ciphertext=NULL,
           refresh_token_nonce=NULL,refresh_token_key_id=NULL,
           updated_at=$3,terminal_at=COALESCE(terminal_at,$3)
       WHERE id=$1`,
      [deletionRequestId, state, terminalAt],
    );
    if (result.rowCount !== 1) throw new Error("account deletion request not found");
  }

  async eraseLocally(deletionRequestId: AccountDeletionId): Promise<void> {
    await this.transactions.run(async ({ db }) => {
      const request = await db.query<ErasureRequestRow>(
        "SELECT user_id,state FROM account_deletion_request WHERE id=$1 FOR UPDATE",
        [deletionRequestId],
      );
      const row = request.rows[0];
      if (!row) throw new Error("account deletion request not found");
      if (
        [
          "locally_erased",
          "apple_revocation_pending",
          "complete",
          "manual_action_required",
        ].includes(row.state)
      ) {
        return;
      }
      if (!row.user_id) throw new Error("account deletion request has no user to erase");
      const userId = row.user_id;
      const erasedAt = this.clock();

      await db.query(
        "UPDATE account_deletion_request SET state='erasing',updated_at=$2 WHERE id=$1",
        [deletionRequestId, erasedAt],
      );
      const user = await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
      if (!user.rows[0]) throw new Error("account deletion user disappeared before erasure");

      const jars = await db.query<ErasureJarRow>(
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
      for (const jar of jars.rows) {
        const active = await db.query<ActiveMemberRow>(
          `SELECT id,user_id FROM memberships
           WHERE jar_id=$1 AND user_id<>$2 AND left_at IS NULL
           ORDER BY joined_at,id FOR UPDATE`,
          [jar.id, userId],
        );
        const departingWasActive = jar.departing_role !== null && jar.departing_left_at === null;
        if (active.rows.length === 0 && (jar.created_by === userId || departingWasActive)) {
          await db.query("DELETE FROM jars WHERE id=$1", [jar.id]);
          continue;
        }

        const creatorIsDeparting = jar.created_by === userId;
        const ownerIsDeparting = departingWasActive && jar.departing_role === "owner";
        if ((creatorIsDeparting || ownerIsDeparting) && active.rows[0]) {
          await db.query(
            "UPDATE memberships SET role='member' WHERE jar_id=$1 AND left_at IS NULL AND user_id<>$2",
            [jar.id, userId],
          );
          await db.query("UPDATE memberships SET role='owner' WHERE id=$1", [active.rows[0].id]);
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
        `DELETE FROM activity
         WHERE actor_id=$1 OR target_id=$1 OR report_id IN (
           SELECT id FROM reports WHERE accuser_id=$1 OR accused_id=$1
         )`,
        [userId],
      );
      await db.query("DELETE FROM reports WHERE accuser_id=$1 OR accused_id=$1", [userId]);
      await db.query("DELETE FROM slips WHERE user_id=$1", [userId]);
      await db.query("UPDATE slips SET reported_by=NULL,note=NULL WHERE reported_by=$1", [userId]);
      await db.query("DELETE FROM users WHERE id=$1", [userId]);
      await db.query(
        `UPDATE account_deletion_request
         SET state='locally_erased',aggregate_version=aggregate_version+1,
             updated_at=$2,locally_erased_at=$2
         WHERE id=$1`,
        [deletionRequestId, erasedAt],
      );
    });
  }
}
