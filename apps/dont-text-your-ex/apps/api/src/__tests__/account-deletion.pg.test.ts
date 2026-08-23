import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccountDeletionIdSchema } from "../../../../contracts";
import {
  createAccountDeletionCipher,
  PostgresAccountDeletionStore,
  parseAccountDeletionKeyring,
} from "../account-deletion";
import { pool } from "../db/index";
import { runMigrations } from "../db/migrate";
import { DomainTransactionRunner } from "../domain-transaction";
import { PostgresOutbox } from "../outbox";
import { buildApp } from "../server";
import * as store from "../store";

const HAS_DB = !!process.env.DATABASE_URL;

beforeAll(async () => {
  if (!HAS_DB) return;
  await runMigrations();
});

beforeEach(async () => {
  if (!HAS_DB) return;
  await pool.query(`
    TRUNCATE deletion_restore_tombstone, account_deletion_cleanup_item,
             account_deletion_request, domain_event, jar_milestones, membership_tenures,
             report_evidence, reports, activity, slips, memberships,
             sessions, otps, user_exes, jars, users RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  if (!HAS_DB) return;
  await pool.end();
});

describe.skipIf(!HAS_DB)("account deletion acceptance", () => {
  it("persists a fresh Apple authorization code only as request-bound ciphertext", async () => {
    const user = await store.createUser({ name: "Credential User", authProvider: "apple" });
    const clock = () => 1_787_500_000_000;
    const cipher = createAccountDeletionCipher(
      parseAccountDeletionKeyring({
        activeKeyId: "test-v1",
        keys: { "test-v1": Buffer.alloc(32, 4).toString("base64") },
      }),
    );
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool, clock }),
      clock,
      cipher,
    );

    const receipt = await deletions.request({
      userId: user.id,
      authorizationCode: "single-use-authorization-code",
    });

    await expect(deletions.loadAuthorizationCode(receipt.deletionRequestId)).resolves.toBe(
      "single-use-authorization-code",
    );
    const persisted = await pool.query(
      "SELECT authorization_code_ciphertext,authorization_code_nonce,authorization_code_key_id FROM account_deletion_request WHERE id=$1",
      [receipt.deletionRequestId],
    );
    expect(JSON.stringify(persisted.rows)).not.toContain("single-use-authorization-code");

    await deletions.saveRefreshToken(receipt.deletionRequestId, "durable-refresh-token");
    await expect(deletions.loadAuthorizationCode(receipt.deletionRequestId)).resolves.toBeNull();
    await expect(deletions.loadRefreshToken(receipt.deletionRequestId)).resolves.toBe(
      "durable-refresh-token",
    );
    const refreshed = await pool.query(
      `SELECT state,authorization_code_ciphertext,refresh_token_ciphertext
       FROM account_deletion_request WHERE id=$1`,
      [receipt.deletionRequestId],
    );
    expect(refreshed.rows[0]).toMatchObject({
      state: "apple_revocation_pending",
      authorization_code_ciphertext: null,
      refresh_token_ciphertext: expect.any(String),
    });
    expect(JSON.stringify(refreshed.rows)).not.toContain("durable-refresh-token");

    await deletions.markTerminal(receipt.deletionRequestId, "complete");
    await expect(deletions.loadRefreshToken(receipt.deletionRequestId)).resolves.toBeNull();
    const terminal = await pool.query(
      `SELECT state,authorization_code_ciphertext,refresh_token_ciphertext,terminal_at
       FROM account_deletion_request WHERE id=$1`,
      [receipt.deletionRequestId],
    );
    expect(terminal.rows[0]).toEqual({
      state: "complete",
      authorization_code_ciphertext: null,
      refresh_token_ciphertext: null,
      terminal_at: String(clock()),
    });
  });

  it("exposes an authenticated, explicitly confirmed deletion request and rejects the old token", async () => {
    const user = await store.createUser({ name: "HTTP User", authProvider: "apple" });
    const token = await store.createSession(user.id);
    const app = buildApp();

    const anonymous = await app.request("/api/me", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmed: true,
        authorizationCode: "http-single-use-authorization-code",
      }),
    });
    expect(anonymous.status).toBe(401);

    const unconfirmed = await app.request("/api/me", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: false }),
    });
    expect(unconfirmed.status).toBe(400);

    const accepted = await app.request("/api/me", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmed: true,
        authorizationCode: "http-single-use-authorization-code",
      }),
    });
    expect(accepted.status).toBe(202);
    const acceptedBody = (await accepted.json()) as Record<string, unknown>;
    expect(acceptedBody).toMatchObject({
      status: "accepted",
      deletionRequestId: expect.stringMatching(/^del_[a-f0-9]{32}$/),
    });
    const deletionRequestId = AccountDeletionIdSchema.parse(acceptedBody.deletionRequestId);
    const localCipher = createAccountDeletionCipher(
      parseAccountDeletionKeyring({
        activeKeyId: "local",
        keys: { local: Buffer.alloc(32, 11).toString("base64") },
      }),
    );
    const persistedDeletion = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool }),
      Date.now,
      localCipher,
    );
    await expect(persistedDeletion.loadAuthorizationCode(deletionRequestId)).resolves.toBe(
      "http-single-use-authorization-code",
    );

    const oldSession = await app.request("/api/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(oldSession.status).toBe(401);
  });

  it("accepts one opaque deletion request and invalidates every session atomically", async () => {
    const user = await store.createUser({
      name: "Delete Me",
      appleId: "apple-subject-never-in-workflow-history",
      authProvider: "apple",
    });
    const firstSession = await store.createSession(user.id);
    const secondSession = await store.createSession(user.id);
    const clock = () => 1_787_500_000_000;
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool, clock }),
      clock,
    );

    const receipt = await deletions.request({ userId: user.id });

    expect(receipt).toMatchObject({ status: "accepted" });
    expect(receipt.deletionRequestId).toMatch(/^del_[a-f0-9]{32}$/);
    await expect(deletions.load(receipt.deletionRequestId)).resolves.toMatchObject({
      id: receipt.deletionRequestId,
      state: "accepted",
    });
    await expect(store.userIdForToken(firstSession)).resolves.toBeNull();
    await expect(store.userIdForToken(secondSession)).resolves.toBeNull();
    await expect(store.createSession(user.id)).rejects.toThrow("account is being deleted");

    const [claimed] = await new PostgresOutbox(pool).claimPage({
      owner: "account-deletion-test",
      now: clock(),
      leaseUntil: clock() + 30_000,
      limit: 10,
    });
    expect(claimed).toMatchObject({
      type: "account.deletion_requested",
      aggregateId: receipt.deletionRequestId,
      aggregateType: "account_deletion",
    });
    expect(JSON.stringify(claimed)).not.toContain(user.id);
    expect(JSON.stringify(claimed)).not.toContain("apple-subject");
  });

  it("erases the person while preserving a shared jar with the deterministic active successor", async () => {
    const clock = () => 1_787_500_100_000;
    await pool.query(
      `INSERT INTO users (id,name,auth_provider,created_at) VALUES
         ('usr_delete','Delete Me','apple',1),
         ('usr_early_departed','Former Member','demo',2),
         ('usr_successor','Successor','demo',3),
         ('usr_other','Other Friend','demo',4),
         ('usr_unrelated','Unrelated','demo',5);
       INSERT INTO jars
         (id,name,rule,created_by,invite_code,invite_expires_at,invite_version_id,created_at)
       VALUES
         ('jar_shared','Private breakup jar','Never message Alex','usr_delete','ABC234',9999999999999,'inv_oldshared',1),
         ('jar_unrelated','Unrelated jar','Keep me','usr_unrelated','XYZ234',9999999999999,'inv_unrelated',2);
       INSERT INTO memberships (id,jar_id,user_id,role,joined_at,left_at) VALUES
         ('mem_delete','jar_shared','usr_delete','owner',10,NULL),
         ('mem_departed','jar_shared','usr_early_departed','member',5,15),
         ('mem_successor','jar_shared','usr_successor','member',20,NULL),
         ('mem_other','jar_shared','usr_other','member',30,NULL),
         ('mem_unrelated','jar_unrelated','usr_unrelated','owner',1,NULL);
       INSERT INTO slips (id,jar_id,user_id,amount_cents,note,source,reported_by,created_at) VALUES
         ('slip_delete','jar_shared','usr_delete',500,'delete this','self',NULL,20),
         ('slip_other','jar_shared','usr_other',500,'reported private note','report','usr_delete',21);
       INSERT INTO reports (id,jar_id,accuser_id,accused_id,note,created_at) VALUES
         ('rpt_delete','jar_shared','usr_delete','usr_other','private allegation',30);
       INSERT INTO report_evidence (id,report_id,payload,created_at)
         VALUES ('ev_delete','rpt_delete','private evidence',31);
       INSERT INTO activity (id,jar_id,actor_id,target_id,type,text,report_id,created_at) VALUES
         ('act_delete','jar_shared','usr_delete','usr_other','report','private activity','rpt_delete',32);`,
    );
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool, clock }),
      clock,
    );
    const receipt = await deletions.request({ userId: "usr_delete" as never });

    await deletions.eraseLocally(receipt.deletionRequestId);

    const request = await pool.query(
      "SELECT user_id,state,locally_erased_at FROM account_deletion_request WHERE id=$1",
      [receipt.deletionRequestId],
    );
    expect(request.rows[0]).toEqual({
      user_id: null,
      state: "locally_erased",
      locally_erased_at: String(clock()),
    });
    expect((await pool.query("SELECT id FROM users WHERE id='usr_delete'")).rowCount).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT name,rule,created_by,closed_by,invite_code,invite_version_id FROM jars WHERE id='jar_shared'",
        )
      ).rows[0],
    ).toMatchObject({
      name: "Shared jar",
      rule: "",
      created_by: null,
      closed_by: null,
      invite_code: expect.not.stringMatching(/^ABC234$/),
      invite_version_id: expect.not.stringMatching(/^inv_oldshared$/),
    });
    expect(
      (
        await pool.query(
          "SELECT user_id,role FROM memberships WHERE jar_id='jar_shared' AND left_at IS NULL ORDER BY joined_at,id",
        )
      ).rows,
    ).toEqual([
      { user_id: "usr_successor", role: "owner" },
      { user_id: "usr_other", role: "member" },
    ]);
    expect((await pool.query("SELECT id FROM slips WHERE id='slip_delete'")).rowCount).toBe(0);
    expect(
      (await pool.query("SELECT note,reported_by FROM slips WHERE id='slip_other'")).rows[0],
    ).toEqual({
      note: null,
      reported_by: null,
    });
    expect((await pool.query("SELECT id FROM reports WHERE id='rpt_delete'")).rowCount).toBe(0);
    expect((await pool.query("SELECT id FROM report_evidence WHERE id='ev_delete'")).rowCount).toBe(
      0,
    );
    expect((await pool.query("SELECT id FROM activity WHERE id='act_delete'")).rowCount).toBe(0);
    expect((await pool.query("SELECT name FROM jars WHERE id='jar_unrelated'")).rows[0]).toEqual({
      name: "Unrelated jar",
    });
  });

  it("deletes a sole-active-member jar without promoting a former member", async () => {
    const clock = () => 1_787_500_200_000;
    await pool.query(
      `INSERT INTO users (id,name,auth_provider,created_at) VALUES
         ('usr_delete','Delete Me','apple',1),('usr_former','Former','demo',2);
       INSERT INTO jars
         (id,name,created_by,invite_code,invite_expires_at,invite_version_id,created_at)
       VALUES ('jar_solo','Solo private jar','usr_delete','SOLO24',9999999999999,'inv_solo',1);
       INSERT INTO memberships (id,jar_id,user_id,role,joined_at,left_at) VALUES
         ('mem_delete','jar_solo','usr_delete','owner',10,NULL),
         ('mem_former','jar_solo','usr_former','member',5,8);`,
    );
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool, clock }),
      clock,
    );
    const receipt = await deletions.request({ userId: "usr_delete" as never });

    await deletions.eraseLocally(receipt.deletionRequestId);
    await deletions.eraseLocally(receipt.deletionRequestId);

    expect((await pool.query("SELECT id FROM jars WHERE id='jar_solo'")).rowCount).toBe(0);
    await expect(deletions.load(receipt.deletionRequestId)).resolves.toMatchObject({
      state: "locally_erased",
    });
  });
});
