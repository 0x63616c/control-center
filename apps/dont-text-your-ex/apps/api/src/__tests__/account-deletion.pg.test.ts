import {
  createNotificationStore,
  createTokenCipher,
  parseTokenKeyring,
} from "@dont-text-your-ex/notifications";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountDeletionIdSchema,
  NotificationDeliveryIdSchema,
  NotificationIdSchema,
  PushInstallationIdSchema,
} from "../../../../contracts";
import { createNotificationActivities } from "../../../temporal-worker/src/notification-activities";
import {
  createAccountDeletionCipher,
  PostgresAccountDeletionStore,
  parseAccountDeletionKeyring,
} from "../account-deletion";
import { completeAppleAccountSignIn } from "../apple-auth";
import { pool } from "../db/index";
import { runMigrations } from "../db/migrate";
import { AmbiguousDomainTransactionError, DomainTransactionRunner } from "../domain-transaction";
import { PostgresOutbox } from "../outbox";
import { replayRestoreTombstones } from "../restore-replay";
import {
  createFileRestoreTombstoneService,
  parseRestoreTombstoneKeyring,
} from "../restore-tombstone";
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
  it("holds the account fence until concurrent session creation commits", async () => {
    const user = await store.createUser({ name: "Session Race", authProvider: "apple" });
    const blocker = await pool.connect();
    const triggerLock = 86_753_091;
    await blocker.query("SELECT pg_advisory_lock($1)", [triggerLock]);
    await pool.query(`
      CREATE FUNCTION block_session_insert_for_deletion_test() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${triggerLock});
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER block_session_insert_for_deletion_test
      BEFORE INSERT ON sessions FOR EACH ROW
      EXECUTE FUNCTION block_session_insert_for_deletion_test();
    `);

    try {
      const session = store.createSession(user.id);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await pool.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE datname=current_database() AND wait_event='advisory'
             AND query LIKE 'INSERT INTO sessions%'`,
        );
        if (waiting.rowCount) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (attempt === 99) throw new Error("session insert did not reach the test barrier");
      }

      const deletions = new PostgresAccountDeletionStore(
        pool,
        new DomainTransactionRunner({ pool }),
      );
      let deletionSettled = false;
      const deletion = deletions.request({ userId: user.id }).finally(() => {
        deletionSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(deletionSettled).toBe(false);

      await blocker.query("SELECT pg_advisory_unlock($1)", [triggerLock]);
      await expect(session).resolves.toMatch(/^sess_/);
      await expect(deletion).resolves.toMatchObject({ status: "accepted" });
      expect(
        (await pool.query("SELECT 1 FROM sessions WHERE user_id=$1", [user.id])).rowCount,
      ).toBe(0);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock($1)", [triggerLock]).catch(() => undefined);
      blocker.release();
      await pool.query(`
        DROP TRIGGER IF EXISTS block_session_insert_for_deletion_test ON sessions;
        DROP FUNCTION IF EXISTS block_session_insert_for_deletion_test();
      `);
    }
  });

  it("serializes in-flight mutations before deletion and rejects stale authenticated writes", async () => {
    const user = await store.createUser({ name: "Mutation Race", authProvider: "apple" });
    const token = await store.createSession(user.id);
    const deletions = new PostgresAccountDeletionStore(pool, new DomainTransactionRunner({ pool }));
    let enterMutation: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enterMutation = resolve;
    });
    let releaseMutation: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutation = store.withActiveAccountRequest(user.id, async () => {
      enterMutation?.();
      await release;
      await pool.query("UPDATE users SET color='#112233' WHERE id=$1", [user.id]);
    });
    await entered;

    let deletionSettled = false;
    const deletion = deletions.request({ userId: user.id }).finally(() => {
      deletionSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(deletionSettled).toBe(false);

    releaseMutation?.();
    await expect(mutation).resolves.toEqual({ active: true, value: undefined });
    await expect(deletion).resolves.toMatchObject({ status: "accepted" });

    let staleOperationRan = false;
    await expect(
      store.withActiveAccountRequest(user.id, async () => {
        staleOperationRan = true;
      }),
    ).resolves.toEqual({ active: false });
    expect(staleOperationRan).toBe(false);

    const staleResponse = await buildApp().request("/api/jars", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Must not be created" }),
    });
    expect(staleResponse.status).toBe(401);
    expect(
      (await pool.query("SELECT id FROM jars WHERE name='Must not be created'")).rowCount,
    ).toBe(0);
  });

  it("waits for an in-flight APNs send and suppresses every send after deletion acceptance", async () => {
    const user = await store.createUser({ name: "Push Fence", authProvider: "apple" });
    const notificationStore = createNotificationStore(
      pool,
      createTokenCipher(
        parseTokenKeyring({
          activeKeyId: "test",
          keys: { test: Buffer.alloc(32, 7).toString("base64") },
        }),
      ),
    );
    await notificationStore.registerDevice(user.id, {
      installationId: PushInstallationIdSchema.parse("dev_deletionfence"),
      token: "ab".repeat(32),
      platform: "ios",
      environment: "sandbox",
      appVersion: "1.0",
      appBuild: "25",
    });
    const firstNotification = NotificationIdSchema.parse("ntf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const secondNotification = NotificationIdSchema.parse("ntf_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    await pool.query(
      `INSERT INTO user_notification
         (id,recipient_user_id,category,dedupe_key,target_type,message_key,created_at)
       VALUES ($1,$3,'report','deletion-fence-first','activity','report.pending',1),
              ($2,$3,'report','deletion-fence-second','activity','report.pending',1)`,
      [firstNotification, secondNotification, user.id],
    );
    const [firstDelivery] = await notificationStore.prepareDeliveries(firstNotification);
    const [secondDelivery] = await notificationStore.prepareDeliveries(secondNotification);
    if (!firstDelivery || !secondDelivery) throw new Error("delivery preparation failed");
    let markSendStarted: (() => void) | undefined;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    let releaseSend: (() => void) | undefined;
    const sendRelease = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const send = vi.fn(async () => {
      markSendStarted?.();
      await sendRelease;
      return { kind: "accepted" as const, apnsId: "apns-fenced" };
    });
    const activities = createNotificationActivities({
      store: notificationStore,
      apnsClient: () => ({ send }),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const delivery = activities.deliverNotification({
      deliveryId: firstDelivery,
      finalAttempt: false,
    });
    await sendStarted;

    const deletions = new PostgresAccountDeletionStore(pool, new DomainTransactionRunner({ pool }));
    let deletionSettled = false;
    const deletion = deletions.request({ userId: user.id }).finally(() => {
      deletionSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(deletionSettled).toBe(false);

    releaseSend?.();
    await expect(delivery).resolves.toMatchObject({ kind: "accepted" });
    await expect(deletion).resolves.toMatchObject({ status: "accepted" });
    await expect(
      activities.deliverNotification({ deliveryId: secondDelivery, finalAttempt: false }),
    ).resolves.toEqual({ kind: "already_terminal", state: "suppressed" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("rejects an invalid persisted notification recipient at the account fence boundary", async () => {
    const notificationStore = createNotificationStore(
      pool,
      createTokenCipher(
        parseTokenKeyring({
          activeKeyId: "test",
          keys: { test: Buffer.alloc(32, 7).toString("base64") },
        }),
      ),
    );
    const deliveryId = NotificationDeliveryIdSchema.parse("ndl_cccccccccccccccccccccccccccccccc");
    await pool.query(
      `INSERT INTO users (id,name,auth_provider,created_at)
       VALUES ('malformed-user-id','Malformed Recipient','demo',1)`,
    );
    await pool.query(
      `INSERT INTO push_device
         (installation_id,user_id,platform,environment,token_ciphertext,token_nonce,
          token_key_id,token_sha256,app_version,app_build,active,last_registered_at)
       VALUES ('dev_malformed','malformed-user-id','ios','sandbox','ciphertext','nonce',
               'test','malformed-hash','1.0','25',TRUE,1)`,
    );
    await pool.query(
      `INSERT INTO user_notification
         (id,recipient_user_id,category,dedupe_key,target_type,message_key,created_at)
       VALUES ('ntf_cccccccccccccccccccccccccccccccc','malformed-user-id','report',
               'malformed-recipient','activity','report.pending',1)`,
    );
    await pool.query(
      `INSERT INTO notification_delivery
         (id,notification_id,installation_id,status,created_at,updated_at)
       VALUES ($1,'ntf_cccccccccccccccccccccccccccccccc','dev_malformed','pending',1,1)`,
      [deliveryId],
    );
    const effect = vi.fn(async () => undefined);

    await expect(notificationStore.withDeliveryAccountFence(deliveryId, effect)).rejects.toThrow(
      "invalid UserId",
    );
    expect(effect).not.toHaveBeenCalled();
  });

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
      appleSubject: "apple-subject",
    });

    await expect(
      deletions.loadAppleRevocationCredential(receipt.deletionRequestId),
    ).resolves.toEqual({
      authorizationCode: "single-use-authorization-code",
      expectedSubject: "apple-subject",
    });
    const persisted = await pool.query(
      `SELECT authorization_code_ciphertext,authorization_code_nonce,authorization_code_key_id,
              apple_subject_ciphertext,apple_subject_nonce,apple_subject_key_id
       FROM account_deletion_request WHERE id=$1`,
      [receipt.deletionRequestId],
    );
    expect(JSON.stringify(persisted.rows)).not.toContain("single-use-authorization-code");
    expect(JSON.stringify(persisted.rows)).not.toContain("apple-subject");

    await deletions.saveRefreshToken(receipt.deletionRequestId, "durable-refresh-token");
    await expect(
      deletions.loadAppleRevocationCredential(receipt.deletionRequestId),
    ).resolves.toBeNull();
    await expect(deletions.loadRefreshToken(receipt.deletionRequestId)).resolves.toBe(
      "durable-refresh-token",
    );
    const refreshed = await pool.query(
      `SELECT state,authorization_code_ciphertext,apple_subject_ciphertext,refresh_token_ciphertext
       FROM account_deletion_request WHERE id=$1`,
      [receipt.deletionRequestId],
    );
    expect(refreshed.rows[0]).toMatchObject({
      state: "apple_revocation_pending",
      authorization_code_ciphertext: null,
      apple_subject_ciphertext: null,
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
    await expect(deletions.listTerminalDeletionWorkflows(clock() - 1, 100)).resolves.toEqual([]);
    await expect(deletions.listTerminalDeletionWorkflows(clock(), 100)).resolves.toEqual([
      {
        deletionRequestId: receipt.deletionRequestId,
        workflowId: `deletion/${receipt.deletionRequestId}`,
      },
    ]);
    await deletions.markCleanupState(
      receipt.deletionRequestId,
      `deletion/${receipt.deletionRequestId}`,
      "deleted",
    );
    await expect(deletions.listTerminalDeletionWorkflows(clock(), 100)).resolves.toEqual([]);
  });

  it("makes terminal credential destruction atomic and idempotent", async () => {
    const user = await store.createUser({ name: "Terminal Rollback", authProvider: "apple" });
    const cipher = createAccountDeletionCipher(
      parseAccountDeletionKeyring({
        activeKeyId: "test-v1",
        keys: { "test-v1": Buffer.alloc(32, 8).toString("base64") },
      }),
    );
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool }),
      Date.now,
      cipher,
    );
    const receipt = await deletions.request({
      userId: user.id,
      authorizationCode: "must-survive-rollback",
      appleSubject: "rollback-apple-subject",
    });
    await pool.query(`
      CREATE FUNCTION reject_account_deletion_event_cleanup() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced event cleanup failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_account_deletion_event_cleanup
      BEFORE DELETE ON domain_event
      FOR EACH ROW WHEN (OLD.aggregate_type = 'account_deletion')
      EXECUTE FUNCTION reject_account_deletion_event_cleanup();
    `);
    try {
      await expect(deletions.markTerminal(receipt.deletionRequestId, "complete")).rejects.toThrow(
        "forced event cleanup failure",
      );
      await expect(deletions.load(receipt.deletionRequestId)).resolves.toMatchObject({
        state: "accepted",
      });
      await expect(
        deletions.loadAppleRevocationCredential(receipt.deletionRequestId),
      ).resolves.toEqual({
        authorizationCode: "must-survive-rollback",
        expectedSubject: "rollback-apple-subject",
      });
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS reject_account_deletion_event_cleanup ON domain_event;
        DROP FUNCTION IF EXISTS reject_account_deletion_event_cleanup();
      `);
    }

    await deletions.markTerminal(receipt.deletionRequestId, "complete");
    const versionAfterFirst = await pool.query<{ aggregate_version: number }>(
      "SELECT aggregate_version FROM account_deletion_request WHERE id=$1",
      [receipt.deletionRequestId],
    );
    await deletions.markTerminal(receipt.deletionRequestId, "complete");
    const versionAfterReplay = await pool.query<{ aggregate_version: number }>(
      "SELECT aggregate_version FROM account_deletion_request WHERE id=$1",
      [receipt.deletionRequestId],
    );
    expect(versionAfterReplay.rows[0]).toEqual(versionAfterFirst.rows[0]);
    await expect(
      deletions.markTerminal(receipt.deletionRequestId, "manual_action_required"),
    ).rejects.toThrow("conflicting terminal account deletion state");
    await expect(deletions.load(receipt.deletionRequestId)).resolves.toMatchObject({
      state: "complete",
    });
  });

  it("withholds deletion workflow history until every associated history is deleted", async () => {
    const user = await store.createUser({ name: "History Ordering", authProvider: "apple" });
    const clock = () => 1_787_500_050_000;
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool, clock }),
      clock,
    );
    const receipt = await deletions.request({ userId: user.id });
    await pool.query(
      `INSERT INTO account_deletion_cleanup_item
         (deletion_request_id,workflow_id,state,updated_at)
       VALUES ($1,'report/rpt_associated','terminated',$2)`,
      [receipt.deletionRequestId, clock()],
    );
    await deletions.markTerminal(receipt.deletionRequestId, "complete");

    await expect(deletions.listTerminalDeletionWorkflows(clock(), 100)).resolves.toEqual([]);

    await deletions.markCleanupState(receipt.deletionRequestId, "report/rpt_associated", "deleted");
    await expect(deletions.listTerminalDeletionWorkflows(clock(), 100)).resolves.toEqual([
      {
        deletionRequestId: receipt.deletionRequestId,
        workflowId: `deletion/${receipt.deletionRequestId}`,
      },
    ]);
  });

  it("purges expired journal and operational rows only after every history is deleted", async () => {
    const user = await store.createUser({ name: "Retention Proof", authProvider: "apple" });
    const clock = () => 1_787_500_075_000;
    const remove = vi.fn(async () => undefined);
    const tombstones = {
      prepare: ({
        deletionRequestId,
        createdAt,
      }: {
        deletionRequestId: never;
        createdAt: number;
      }) => ({
        schemaVersion: 1 as const,
        deletionRequestId,
        userHmac: "a".repeat(64),
        hmacKeyVersion: "test",
        completedAt: null,
        expiresAt: createdAt + 31 * 24 * 60 * 60 * 1000,
        signatureVersion: 1 as const,
        signatureKeyVersion: "test",
        signature: "b".repeat(64),
      }),
      complete: vi.fn(),
      stageIntent: vi.fn(async () => undefined),
      publish: vi.fn(async () => undefined),
      discardIntent: vi.fn(async () => undefined),
      remove,
    };
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool, clock }),
      clock,
      undefined,
      tombstones as never,
    );
    const receipt = await deletions.request({ userId: user.id });
    await deletions.markTerminal(receipt.deletionRequestId, "complete");
    await pool.query(
      "UPDATE deletion_restore_tombstone SET expires_at=$2 WHERE deletion_request_id=$1",
      [receipt.deletionRequestId, clock()],
    );

    await expect(deletions.purgeExpiredRecords(clock(), 100)).resolves.toEqual({ deleted: 0 });
    expect(remove).not.toHaveBeenCalled();

    await deletions.markCleanupState(
      receipt.deletionRequestId,
      `deletion/${receipt.deletionRequestId}`,
      "deleted",
    );
    await expect(deletions.purgeExpiredRecords(clock(), 100)).resolves.toEqual({ deleted: 1 });
    expect(remove).toHaveBeenCalledOnce();
    expect((await pool.query("SELECT id FROM account_deletion_request")).rowCount).toBe(0);
    expect(
      (await pool.query("SELECT deletion_request_id FROM deletion_restore_tombstone")).rowCount,
    ).toBe(0);
    expect((await pool.query("SELECT 1 FROM account_deletion_cleanup_item")).rowCount).toBe(0);
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
      body: JSON.stringify({ confirmed: true }),
    });
    expect(accepted.status).toBe(202);
    const acceptedBody = (await accepted.json()) as Record<string, unknown>;
    expect(acceptedBody.status).toBe("accepted");
    expect(typeof acceptedBody.deletionRequestId).toBe("string");
    expect(acceptedBody.deletionRequestId as string).toMatch(/^del_[a-f0-9]{32}$/);
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
    await expect(
      persistedDeletion.loadAppleRevocationCredential(deletionRequestId),
    ).resolves.toBeNull();
    const tombstone = await pool.query(
      `SELECT user_hmac,key_version,signature,signature_key_version,journal_published_at
       FROM deletion_restore_tombstone WHERE deletion_request_id=$1`,
      [deletionRequestId],
    );
    expect(tombstone.rows[0]).toMatchObject({
      user_hmac: expect.stringMatching(/^[a-f0-9]{64}$/),
      key_version: "local",
      signature: expect.stringMatching(/^[a-f0-9]{64}$/),
      signature_key_version: "local",
      journal_published_at: expect.any(String),
    });
    expect(JSON.stringify(tombstone.rows)).not.toContain(user.id);

    const oldSession = await app.request("/api/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(oldSession.status).toBe(401);
  });

  it("refuses deletion of an Apple-linked account without fresh Apple reauthentication", async () => {
    const user = await store.createUser({
      name: "Apple Reauthentication Required",
      appleId: "apple-linked-subject",
      authProvider: "apple",
    });
    const token = await store.createSession(user.id);

    const response = await buildApp().request("/api/me", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });

    expect(response.status).toBe(401);
    expect((await pool.query("SELECT id FROM account_deletion_request")).rowCount).toBe(0);
    await expect(store.userIdForToken(token)).resolves.toBe(user.id);
  });

  it("accepts Apple-linked deletion through the HTTP route after fresh reauthentication", async () => {
    const appleSubject = "apple-linked-positive-subject";
    const user = await store.createUser({
      name: "Fresh Apple Reauthentication",
      appleId: appleSubject,
      authProvider: "apple",
    });
    const token = await store.createSession(user.id);
    const verifier = vi.fn(async () => undefined);
    const response = await buildApp({
      verifyAppleAccountReauthentication: verifier,
    }).request("/api/me", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmed: true,
        authorizationCode: "fresh-apple-authorization-code",
        identityToken: "fresh-apple-identity-token",
        nonce: `nonce_${"a".repeat(48)}`,
      }),
    });

    expect(response.status).toBe(202);
    expect(verifier).toHaveBeenCalledWith({
      identityToken: "fresh-apple-identity-token",
      nonce: `nonce_${"a".repeat(48)}`,
      expectedSubject: appleSubject,
    });
    const body = (await response.json()) as { deletionRequestId: unknown };
    const deletionRequestId = AccountDeletionIdSchema.parse(body.deletionRequestId);
    const persistedDeletion = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool }),
      Date.now,
      createAccountDeletionCipher(
        parseAccountDeletionKeyring({
          activeKeyId: "local",
          keys: { local: Buffer.alloc(32, 11).toString("base64") },
        }),
      ),
    );
    await expect(
      persistedDeletion.loadAppleRevocationCredential(deletionRequestId),
    ).resolves.toEqual({
      authorizationCode: "fresh-apple-authorization-code",
      expectedSubject: appleSubject,
    });
    await expect(store.userIdForToken(token)).resolves.toBeNull();
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
    expect(
      (
        await pool.query(
          "SELECT workflow_id,state FROM account_deletion_cleanup_item WHERE deletion_request_id=$1",
          [receipt.deletionRequestId],
        )
      ).rows,
    ).toEqual([{ workflow_id: `deletion/${receipt.deletionRequestId}`, state: "pending" }]);
  });

  it("deduplicates concurrent and repeated requests for the same account", async () => {
    const user = await store.createUser({ name: "Delete Once", authProvider: "apple" });
    const clock = () => 1_787_500_050_000;
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool, clock }),
      clock,
    );

    const [first, concurrent] = await Promise.all([
      deletions.request({ userId: user.id }),
      deletions.request({ userId: user.id }),
    ]);
    const repeated = await deletions.request({ userId: user.id });

    expect(concurrent).toEqual(first);
    expect(repeated).toEqual(first);
    expect(
      (await pool.query("SELECT id FROM account_deletion_request WHERE user_id=$1", [user.id]))
        .rows,
    ).toEqual([{ id: first.deletionRequestId }]);
    expect(
      (
        await pool.query(
          `SELECT aggregate_id FROM domain_event
           WHERE aggregate_type='account_deletion' AND event_type='account.deletion_requested'`,
        )
      ).rows,
    ).toEqual([{ aggregate_id: first.deletionRequestId }]);
    expect(
      (
        await pool.query(
          "SELECT workflow_id FROM account_deletion_cleanup_item WHERE deletion_request_id=$1",
          [first.deletionRequestId],
        )
      ).rows,
    ).toEqual([{ workflow_id: `deletion/${first.deletionRequestId}` }]);
  });

  it("refreshes the workflow manifest under row locks before erasing late associated work", async () => {
    const deleting = await store.createUser({ name: "Late Work", authProvider: "apple" });
    const friend = await store.createUser({ name: "Late Work Friend", authProvider: "demo" });
    const deletions = new PostgresAccountDeletionStore(pool, new DomainTransactionRunner({ pool }));
    const receipt = await deletions.request({ userId: deleting.id });
    await pool.query(
      `INSERT INTO user_notification
         (id,recipient_user_id,category,dedupe_key,target_type,target_id,message_key,created_at)
       VALUES ('ntf_lateassociated',$1,'report','late-associated','profile',$2,
               'report.pending',3)`,
      [friend.id, deleting.id],
    );

    await deletions.eraseLocally(receipt.deletionRequestId);

    expect(
      (
        await pool.query(
          `SELECT workflow_id,state FROM account_deletion_cleanup_item
           WHERE deletion_request_id=$1 AND workflow_id='notification/ntf_lateassociated'`,
          [receipt.deletionRequestId],
        )
      ).rows,
    ).toEqual([{ workflow_id: "notification/ntf_lateassociated", state: "pending" }]);
    expect(
      (await pool.query("SELECT id FROM user_notification WHERE id='ntf_lateassociated'")).rowCount,
    ).toBe(0);
  });

  it("withholds acknowledgement and republishes the committed tombstone on retry", async () => {
    const user = await store.createUser({ name: "Journal Failure", authProvider: "apple" });
    const token = await store.createSession(user.id);
    const publish = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("journal unavailable"))
      .mockResolvedValue(undefined);
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool }),
      Date.now,
      undefined,
      {
        prepare: ({ deletionRequestId, createdAt }) => ({
          schemaVersion: 1,
          deletionRequestId,
          userHmac: "a".repeat(64),
          hmacKeyVersion: "test",
          completedAt: null,
          expiresAt: createdAt + 31 * 24 * 60 * 60 * 1000,
          signatureVersion: 1,
          signatureKeyVersion: "test",
          signature: "b".repeat(64),
        }),
        complete: vi.fn(),
        stageIntent: vi.fn(async () => undefined),
        publish,
        discardIntent: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    );

    await expect(deletions.request({ userId: user.id })).rejects.toThrow("journal unavailable");

    expect(publish).toHaveBeenCalledOnce();
    expect((await pool.query("SELECT id FROM account_deletion_request")).rowCount).toBe(1);
    expect(
      (await pool.query("SELECT deletion_request_id FROM deletion_restore_tombstone")).rowCount,
    ).toBe(1);
    expect(
      (await pool.query("SELECT deletion_requested_at FROM users WHERE id=$1", [user.id])).rows[0],
    ).toEqual({ deletion_requested_at: expect.any(String) });
    await expect(store.userIdForToken(token)).resolves.toBeNull();

    await expect(deletions.request({ userId: user.id })).resolves.toMatchObject({
      status: "accepted",
    });
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("never publishes an external tombstone when the acceptance transaction rolls back", async () => {
    const user = await store.createUser({ name: "Acceptance Rollback", authProvider: "apple" });
    const token = await store.createSession(user.id);
    const stageIntent = vi.fn(async () => undefined);
    const discardIntent = vi.fn(async () => undefined);
    const tombstones = {
      prepare: ({
        deletionRequestId,
        createdAt,
      }: {
        deletionRequestId: never;
        createdAt: number;
      }) => ({
        schemaVersion: 1 as const,
        deletionRequestId,
        userHmac: "a".repeat(64),
        hmacKeyVersion: "test",
        completedAt: null,
        expiresAt: createdAt + 31 * 24 * 60 * 60 * 1000,
        signatureVersion: 1 as const,
        signatureKeyVersion: "test",
        signature: "b".repeat(64),
      }),
      complete: vi.fn(),
      stageIntent,
      publish: vi.fn(async () => undefined),
      discardIntent,
      remove: vi.fn(async () => undefined),
    };
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool }),
      Date.now,
      undefined,
      tombstones as never,
    );
    await pool.query(`
      CREATE FUNCTION reject_deletion_acceptance_after_journal() RETURNS trigger AS $$
      BEGIN
        IF NEW.deletion_requested_at IS NOT NULL THEN
          RAISE EXCEPTION 'forced post-journal acceptance failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_deletion_acceptance_after_journal
      BEFORE UPDATE ON users FOR EACH ROW
      EXECUTE FUNCTION reject_deletion_acceptance_after_journal();
    `);
    try {
      await expect(deletions.request({ userId: user.id })).rejects.toThrow(
        "forced post-journal acceptance failure",
      );
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS reject_deletion_acceptance_after_journal ON users;
        DROP FUNCTION IF EXISTS reject_deletion_acceptance_after_journal();
      `);
    }
    expect(tombstones.publish).not.toHaveBeenCalled();
    expect(stageIntent).toHaveBeenCalledOnce();
    expect(discardIntent).toHaveBeenCalledOnce();
    expect((await pool.query("SELECT id FROM account_deletion_request")).rowCount).toBe(0);
    await expect(store.userIdForToken(token)).resolves.toBe(user.id);
  });

  it("discards an intent created before staging reports failure and rollback is confirmed", async () => {
    const user = await store.createUser({ name: "Stage Sync Failure", authProvider: "apple" });
    const token = await store.createSession(user.id);
    const visibleIntents = new Set<string>();
    const discardIntent = vi.fn(async (record: { deletionRequestId: string }) => {
      visibleIntents.delete(record.deletionRequestId);
    });
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool }),
      Date.now,
      undefined,
      {
        prepare: ({ deletionRequestId, createdAt }) => ({
          schemaVersion: 1,
          deletionRequestId,
          userHmac: "a".repeat(64),
          hmacKeyVersion: "test",
          completedAt: null,
          expiresAt: createdAt + 31 * 24 * 60 * 60 * 1000,
          signatureVersion: 1,
          signatureKeyVersion: "test",
          signature: "b".repeat(64),
        }),
        complete: vi.fn(),
        stageIntent: async (record) => {
          visibleIntents.add(record.deletionRequestId);
          throw new Error("intent directory sync failed after rename");
        },
        publish: vi.fn(async () => undefined),
        discardIntent,
        remove: vi.fn(async () => undefined),
      },
    );

    await expect(deletions.request({ userId: user.id })).rejects.toThrow(
      "intent directory sync failed after rename",
    );

    expect(discardIntent).toHaveBeenCalledOnce();
    expect(visibleIntents).toEqual(new Set());
    expect((await pool.query("SELECT id FROM account_deletion_request")).rowCount).toBe(0);
    await expect(store.userIdForToken(token)).resolves.toBe(user.id);
  });

  it("retains the restore intent when COMMIT succeeds but its response is lost", async () => {
    const user = await store.createUser({ name: "Ambiguous Commit", authProvider: "apple" });
    const token = await store.createSession(user.id);
    const stageIntent = vi.fn(async () => undefined);
    const publish = vi.fn(async () => undefined);
    const discardIntent = vi.fn(async () => undefined);
    const ambiguousPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (statement: string, values?: unknown[]) => {
            if (statement === "COMMIT") {
              await client.query("COMMIT");
              throw new Error("commit response lost");
            }
            if (statement === "ROLLBACK") throw new Error("connection unavailable");
            return client.query(statement, values);
          },
          release: () => client.release(),
        } as never;
      },
    };
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool: ambiguousPool as never }),
      Date.now,
      undefined,
      {
        prepare: ({ deletionRequestId, createdAt }) => ({
          schemaVersion: 1,
          deletionRequestId,
          userHmac: "a".repeat(64),
          hmacKeyVersion: "test",
          completedAt: null,
          expiresAt: createdAt + 31 * 24 * 60 * 60 * 1000,
          signatureVersion: 1,
          signatureKeyVersion: "test",
          signature: "b".repeat(64),
        }),
        complete: vi.fn(),
        stageIntent,
        publish,
        discardIntent,
        remove: vi.fn(async () => undefined),
      },
    );

    await expect(deletions.request({ userId: user.id })).rejects.toBeInstanceOf(
      AmbiguousDomainTransactionError,
    );

    expect(stageIntent).toHaveBeenCalledOnce();
    expect(discardIntent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect((await pool.query("SELECT id FROM account_deletion_request")).rowCount).toBe(1);
    await expect(store.userIdForToken(token)).resolves.toBeNull();
  });

  it("erases the person while preserving a shared jar with the deterministic active successor", async () => {
    const clock = () => 1_787_500_100_000;
    await pool.query(
      `INSERT INTO users (id,name,phone,apple_id,auth_provider,created_at) VALUES
         ('usr_delete','Delete Me','+15550001111','apple-subject-shared-rejoin','apple',1),
         ('usr_earlydeparted','Former Member',NULL,NULL,'demo',2),
         ('usr_successor','Successor',NULL,NULL,'demo',3),
         ('usr_other','Other Friend',NULL,NULL,'demo',4),
         ('usr_unrelated','Unrelated',NULL,NULL,'demo',5);
       INSERT INTO otps (phone,code,created_at) VALUES ('+15550001111','123456',1);
       INSERT INTO jars
         (id,name,rule,created_by,invite_code,invite_expires_at,invite_version_id,created_at)
       VALUES
         ('jar_shared','Private breakup jar','Never message Alex','usr_delete','ABC234',9999999999999,'inv_oldshared',1),
         ('jar_unrelated','Unrelated jar','Keep me','usr_unrelated','XYZ234',9999999999999,'inv_unrelated',2);
       INSERT INTO memberships (id,jar_id,user_id,role,joined_at,left_at) VALUES
         ('mem_delete','jar_shared','usr_delete','owner',10,NULL),
         ('mem_departed','jar_shared','usr_earlydeparted','member',5,15),
         ('mem_successor','jar_shared','usr_successor','member',20,NULL),
         ('mem_other','jar_shared','usr_other','member',30,NULL),
         ('mem_unrelated','jar_unrelated','usr_unrelated','owner',1,NULL);
       INSERT INTO membership_tenures (id,membership_id,joined_at,left_at) VALUES
         ('mtn_delete','mem_delete',10,NULL),
         ('mtn_unrelated','mem_unrelated',1,NULL);
       INSERT INTO streak_achievements
         (id,membership_id,streak_started_at,milestone_days,reached_local_date,created_at) VALUES
         ('sta_delete','mem_delete',10,7,'2026-08-01',20),
         ('sta_unrelated','mem_unrelated',1,7,'2026-08-01',20);
       INSERT INTO notification_preference (user_id,category,enabled,updated_at) VALUES
         ('usr_delete','report',TRUE,20),
         ('usr_unrelated','report',TRUE,20);
       INSERT INTO push_device
         (installation_id,user_id,platform,environment,token_ciphertext,token_nonce,
          token_key_id,token_sha256,app_version,app_build,active,last_registered_at) VALUES
         ('dev_delete','usr_delete','ios','sandbox','cipher-delete','nonce-delete',
          'test','hash-delete','1.0','25',TRUE,20),
         ('dev_unrelated','usr_unrelated','ios','sandbox','cipher-unrelated','nonce-unrelated',
          'test','hash-unrelated','1.0','25',TRUE,20);
       INSERT INTO rescue_interventions
         (id,user_id,state,started_at,deadline_at,updated_at) VALUES
         ('rsi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','usr_delete','active',20,620000,20),
         ('rsi_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','usr_unrelated','active',20,620000,20);
       INSERT INTO slips (id,jar_id,user_id,amount_cents,note,ex_label,source,reported_by,created_at) VALUES
         ('slip_delete','jar_shared','usr_delete',500,'delete this','Alex','self',NULL,20),
         ('slip_other','jar_shared','usr_other',500,'reported private note','Private ex','report','usr_delete',21);
       INSERT INTO reports (id,jar_id,accuser_id,accused_id,note,created_at) VALUES
         ('rpt_delete','jar_shared','usr_delete','usr_other','private allegation',30);
       INSERT INTO jar_invite_version (invite_version_id,jar_id,created_at)
         VALUES ('inv_oldershared','jar_shared',0);
       INSERT INTO user_notification
         (id,recipient_user_id,category,dedupe_key,target_type,target_id,message_key,created_at) VALUES
         ('ntf_reportdelete','usr_other','report','delete-report','report','rpt_delete','report.pending',30),
         ('ntf_activitydelete','usr_other','report','delete-activity','activity','act_delete','report.pending',31);
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

    expect(
      (
        await pool.query(
          "SELECT workflow_id FROM account_deletion_cleanup_item WHERE deletion_request_id=$1 ORDER BY workflow_id",
          [receipt.deletionRequestId],
        )
      ).rows,
    ).toEqual([
      { workflow_id: `deletion/${receipt.deletionRequestId}` },
      { workflow_id: "invite/inv_oldershared" },
      { workflow_id: "invite/inv_oldshared" },
      { workflow_id: "notification/ntf_activitydelete" },
      { workflow_id: "notification/ntf_reportdelete" },
      { workflow_id: "report/rpt_delete" },
      { workflow_id: "rescue/rsi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    ]);

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
      (await pool.query("SELECT note,ex_label,source,reported_by FROM slips WHERE id='slip_other'"))
        .rows[0],
    ).toEqual({
      note: null,
      ex_label: null,
      source: "system",
      reported_by: null,
    });
    expect((await pool.query("SELECT phone FROM otps WHERE phone='+15550001111'")).rowCount).toBe(
      0,
    );
    expect((await pool.query("SELECT id FROM reports WHERE id='rpt_delete'")).rowCount).toBe(0);
    expect((await pool.query("SELECT id FROM report_evidence WHERE id='ev_delete'")).rowCount).toBe(
      0,
    );
    expect((await pool.query("SELECT id FROM activity WHERE id='act_delete'")).rowCount).toBe(0);
    for (const table of [
      "membership_tenures",
      "streak_achievements",
      "notification_preference",
      "push_device",
      "rescue_interventions",
    ]) {
      expect(
        (
          await pool.query(
            `SELECT 1 FROM ${table} WHERE ${
              table === "notification_preference" || table === "push_device"
                ? "user_id='usr_delete'"
                : table === "rescue_interventions"
                  ? "user_id='usr_delete'"
                  : table === "membership_tenures"
                    ? "id='mtn_delete'"
                    : "id='sta_delete'"
            }`,
          )
        ).rowCount,
      ).toBe(0);
    }
    expect(
      (
        await pool.query(
          "SELECT id FROM user_notification WHERE id IN ('ntf_reportdelete','ntf_activitydelete')",
        )
      ).rowCount,
    ).toBe(0);
    expect((await pool.query("SELECT name FROM jars WHERE id='jar_unrelated'")).rows[0]).toEqual({
      name: "Unrelated jar",
    });
    expect(
      (
        await pool.query(
          `SELECT
             (SELECT count(*) FROM users WHERE id='usr_unrelated') AS users,
             (SELECT count(*) FROM membership_tenures WHERE id='mtn_unrelated') AS tenures,
             (SELECT count(*) FROM streak_achievements WHERE id='sta_unrelated') AS achievements,
             (SELECT count(*) FROM notification_preference WHERE user_id='usr_unrelated') AS preferences,
             (SELECT count(*) FROM push_device WHERE user_id='usr_unrelated') AS devices,
             (SELECT count(*) FROM rescue_interventions WHERE user_id='usr_unrelated') AS rescues`,
        )
      ).rows[0],
    ).toEqual({
      users: "1",
      tenures: "1",
      achievements: "1",
      preferences: "1",
      devices: "1",
      rescues: "1",
    });
    await expect(store.listJarsForUser("usr_successor" as never)).resolves.toEqual([
      expect.objectContaining({ id: "jar_shared", name: "Shared jar" }),
    ]);
    await expect(
      store.getJarDetail("jar_shared" as never, "usr_successor" as never),
    ).resolves.toEqual(expect.objectContaining({ id: "jar_shared", name: "Shared jar", rule: "" }));
    const rejoined = await completeAppleAccountSignIn("apple-subject-shared-rejoin", undefined, {
      findUserByAppleId: store.findUserByAppleId,
      createUser: store.createUser,
      createSession: store.createSession,
      getMe: store.getMe,
    });
    expect(rejoined).toMatchObject({ created: true, response: { status: "needs_profile" } });
    expect(rejoined.response.user.id).not.toBe("usr_delete");
    expect(await store.listJarsForUser(rejoined.response.user.id)).toEqual([]);
    expect(
      (
        await pool.query(
          `SELECT COUNT(*)::text AS count FROM reports
           WHERE accuser_id=$1 OR accused_id=$1`,
          [rejoined.response.user.id],
        )
      ).rows[0],
    ).toEqual({ count: "0" });
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::text AS count FROM user_notification WHERE recipient_user_id=$1",
          [rejoined.response.user.id],
        )
      ).rows[0],
    ).toEqual({ count: "0" });
  });

  it("erases an ordinary active member without changing the shared jar owner or authored text", async () => {
    const clock = () => 1_787_500_150_000;
    await pool.query(
      `INSERT INTO users (id,name,auth_provider,created_at) VALUES
         ('usr_owner','Owner','demo',1),
         ('usr_memberdelete','Departing member','apple',2),
         ('usr_peer','Remaining member','demo',3);
       INSERT INTO jars
         (id,name,rule,created_by,invite_code,invite_expires_at,invite_version_id,created_at)
       VALUES
         ('jar_membercase','Owner-authored jar','Owner-authored rule','usr_owner','MEMB24',9999999999999,
          'inv_11111111111111111111111111111111',1);
       INSERT INTO memberships (id,jar_id,user_id,role,joined_at,left_at) VALUES
         ('mem_owner','jar_membercase','usr_owner','owner',10,NULL),
         ('mem_delete','jar_membercase','usr_memberdelete','member',20,NULL),
         ('mem_peer','jar_membercase','usr_peer','member',30,NULL);
       INSERT INTO slips (id,jar_id,user_id,amount_cents,note,ex_label,source,created_at)
         VALUES ('slip_memberdelete','jar_membercase','usr_memberdelete',500,'private note','Private ex','self',40);`,
    );
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool, clock }),
      clock,
    );
    const receipt = await deletions.request({ userId: "usr_memberdelete" as never });

    await deletions.eraseLocally(receipt.deletionRequestId);

    expect((await pool.query("SELECT id FROM users WHERE id='usr_memberdelete'")).rowCount).toBe(0);
    expect(
      (
        await pool.query(
          `SELECT name,rule,created_by,invite_code,invite_version_id
           FROM jars WHERE id='jar_membercase'`,
        )
      ).rows[0],
    ).toMatchObject({
      name: "Owner-authored jar",
      rule: "Owner-authored rule",
      created_by: "usr_owner",
      invite_code: expect.not.stringMatching(/^MEMB24$/),
      invite_version_id: expect.not.stringMatching(/^inv_11111111111111111111111111111111$/),
    });
    expect(
      (
        await pool.query(
          `SELECT user_id,role FROM memberships
           WHERE jar_id='jar_membercase' AND left_at IS NULL ORDER BY joined_at,id`,
        )
      ).rows,
    ).toEqual([
      { user_id: "usr_owner", role: "owner" },
      { user_id: "usr_peer", role: "member" },
    ]);
    expect((await pool.query("SELECT id FROM slips WHERE id='slip_memberdelete'")).rowCount).toBe(
      0,
    );
    await expect(
      store.getJarDetail("jar_membercase" as never, "usr_owner" as never),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "jar_membercase",
        name: "Owner-authored jar",
        rule: "Owner-authored rule",
      }),
    );
  });

  it("erases a former member while preserving the active owner and remaining shared jar", async () => {
    const clock = () => 1_787_500_175_000;
    await pool.query(
      `INSERT INTO users (id,name,auth_provider,created_at) VALUES
         ('usr_owner','Owner','demo',1),
         ('usr_formerdelete','Former member','apple',2);
       INSERT INTO jars
         (id,name,rule,created_by,invite_code,invite_expires_at,invite_version_id,created_at)
       VALUES
         ('jar_formercase','Still active','Keep the rule','usr_owner','FORM24',9999999999999,
          'inv_22222222222222222222222222222222',1);
       INSERT INTO memberships (id,jar_id,user_id,role,joined_at,left_at) VALUES
         ('mem_owner','jar_formercase','usr_owner','owner',10,NULL),
         ('mem_formerdelete','jar_formercase','usr_formerdelete','member',20,30);
       INSERT INTO slips (id,jar_id,user_id,amount_cents,note,ex_label,source,created_at)
         VALUES ('slip_formerdelete','jar_formercase','usr_formerdelete',500,'old private note','Old ex','self',25);`,
    );
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool, clock }),
      clock,
    );
    const receipt = await deletions.request({ userId: "usr_formerdelete" as never });

    await deletions.eraseLocally(receipt.deletionRequestId);

    expect((await pool.query("SELECT id FROM users WHERE id='usr_formerdelete'")).rowCount).toBe(0);
    expect(
      (
        await pool.query(
          `SELECT name,rule,created_by,invite_code,invite_version_id
           FROM jars WHERE id='jar_formercase'`,
        )
      ).rows[0],
    ).toMatchObject({
      name: "Still active",
      rule: "Keep the rule",
      created_by: "usr_owner",
      invite_code: expect.not.stringMatching(/^FORM24$/),
      invite_version_id: expect.not.stringMatching(/^inv_22222222222222222222222222222222$/),
    });
    expect(
      (
        await pool.query(
          "SELECT user_id,role,left_at FROM memberships WHERE jar_id='jar_formercase'",
        )
      ).rows,
    ).toEqual([{ user_id: "usr_owner", role: "owner", left_at: null }]);
    expect((await pool.query("SELECT id FROM slips WHERE id='slip_formerdelete'")).rowCount).toBe(
      0,
    );
    await expect(store.listJarsForUser("usr_owner" as never)).resolves.toEqual([
      expect.objectContaining({ id: "jar_formercase", name: "Still active" }),
    ]);
  });

  it("preserves a closed shared jar without reopening its invite when its owner is erased", async () => {
    const clock = () => 1_787_500_190_000;
    await pool.query(
      `INSERT INTO users (id,name,auth_provider,created_at) VALUES
         ('usr_closedowner','Closed owner','apple',1),
         ('usr_closedsurvivor','Closed survivor','demo',2);
       INSERT INTO jars
         (id,name,rule,created_by,invite_code,invite_expires_at,invite_version_id,
          closed_at,closed_by,created_at)
       VALUES
         ('jar_closedshared','Private closed jar','Private closed rule','usr_closedowner',NULL,NULL,
          'inv_33333333333333333333333333333333',50,'usr_closedowner',1);
       INSERT INTO memberships (id,jar_id,user_id,role,joined_at,left_at) VALUES
         ('mem_closedowner','jar_closedshared','usr_closedowner','owner',10,NULL),
         ('mem_closedsurvivor','jar_closedshared','usr_closedsurvivor','member',20,NULL);`,
    );
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool, clock }),
      clock,
    );
    const receipt = await deletions.request({ userId: "usr_closedowner" as never });

    await deletions.eraseLocally(receipt.deletionRequestId);

    expect((await pool.query("SELECT id FROM users WHERE id='usr_closedowner'")).rowCount).toBe(0);
    expect(
      (
        await pool.query(
          `SELECT name,rule,created_by,closed_at,closed_by,invite_code,invite_expires_at,
                  invite_version_id
           FROM jars WHERE id='jar_closedshared'`,
        )
      ).rows[0],
    ).toEqual({
      name: "Shared jar",
      rule: "",
      created_by: null,
      closed_at: "50",
      closed_by: null,
      invite_code: null,
      invite_expires_at: null,
      invite_version_id: "inv_33333333333333333333333333333333",
    });
    expect(
      (
        await pool.query(
          `SELECT user_id,role FROM memberships
           WHERE jar_id='jar_closedshared' AND left_at IS NULL`,
        )
      ).rows,
    ).toEqual([{ user_id: "usr_closedsurvivor", role: "owner" }]);
    await expect(
      store.getJarDetail("jar_closedshared" as never, "usr_closedsurvivor" as never),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "jar_closedshared",
        name: "Shared jar",
        rule: "",
        inviteCode: null,
        inviteExpiresAt: null,
        closedAt: 50,
        closedBy: null,
      }),
    );
  });

  it("deletes a sole-active-member jar without promoting a former member", async () => {
    const clock = () => 1_787_500_200_000;
    await pool.query(
      `INSERT INTO users (id,name,apple_id,auth_provider,created_at) VALUES
         ('usr_delete','Delete Me','apple-subject-rejoin','apple',1),
         ('usr_former','Former',NULL,'demo',2);
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

    await Promise.all([
      deletions.eraseLocally(receipt.deletionRequestId),
      deletions.eraseLocally(receipt.deletionRequestId),
    ]);

    expect((await pool.query("SELECT id FROM jars WHERE id='jar_solo'")).rowCount).toBe(0);
    await expect(deletions.load(receipt.deletionRequestId)).resolves.toMatchObject({
      state: "locally_erased",
    });

    const rejoined = await completeAppleAccountSignIn("apple-subject-rejoin", undefined, {
      findUserByAppleId: store.findUserByAppleId,
      createUser: store.createUser,
      createSession: store.createSession,
      getMe: store.getMe,
    });
    expect(rejoined).toMatchObject({ created: true, response: { status: "needs_profile" } });
    expect(rejoined.response.user.id).not.toBe("usr_delete");
    expect(await store.listJarsForUser(rejoined.response.user.id)).toEqual([]);
  });

  it("replays duplicate crash-retry tombstones once against an isolated restored database", async () => {
    const now = 1_787_500_250_000;
    await pool.query(
      `INSERT INTO users (id,name,auth_provider,created_at) VALUES
         ('usr_restoredelete','Restored Delete','apple',1),
         ('usr_restorekeep','Restored Keep','demo',2);
       INSERT INTO jars
         (id,name,created_by,invite_code,invite_expires_at,invite_version_id,created_at)
       VALUES ('jar_restore','Restored private jar','usr_restoredelete','RST234',9999999999999,'inv_restore',1);
       INSERT INTO memberships (id,jar_id,user_id,role,joined_at) VALUES
         ('mem_restore','jar_restore','usr_restoredelete','owner',1);`,
    );
    const hmacKeys = parseRestoreTombstoneKeyring({
      activeKeyId: "hmac-v1",
      keys: { "hmac-v1": Buffer.alloc(32, 31).toString("base64") },
    });
    const signingKeys = parseRestoreTombstoneKeyring({
      activeKeyId: "sign-v1",
      keys: { "sign-v1": Buffer.alloc(32, 32).toString("base64") },
    });
    const journal = createFileRestoreTombstoneService({
      directory: "/unused-in-memory-prepare",
      hmacKeys,
      signingKeys,
    });
    const active = journal.prepare({
      deletionRequestId: AccountDeletionIdSchema.parse("del_cccccccccccccccccccccccccccccccc"),
      userId: "usr_restoredelete" as never,
      createdAt: now - 1_000,
    });
    const expired = journal.prepare({
      deletionRequestId: AccountDeletionIdSchema.parse("del_dddddddddddddddddddddddddddddddd"),
      userId: "usr_restorekeep" as never,
      createdAt: now - 32 * 24 * 60 * 60 * 1000,
    });
    const crashRetryDuplicate = journal.prepare({
      deletionRequestId: AccountDeletionIdSchema.parse("del_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
      userId: "usr_restoredelete" as never,
      createdAt: now - 500,
    });

    await expect(
      replayRestoreTombstones({
        pool,
        transactions: new DomainTransactionRunner({ pool, clock: () => now }),
        records: [active, crashRetryDuplicate, expired],
        hmacKeys,
        now,
      }),
    ).resolves.toEqual({
      activeRecords: 2,
      erasedUsers: 1,
      unmatchedRecords: 0,
      scannedTextColumns: expect.any(Number),
      remainingRawReferences: 0,
    });
    expect((await pool.query("SELECT id FROM users WHERE id='usr_restoredelete'")).rowCount).toBe(
      0,
    );
    expect((await pool.query("SELECT id FROM jars WHERE id='jar_restore'")).rowCount).toBe(0);
    expect((await pool.query("SELECT id FROM users WHERE id='usr_restorekeep'")).rowCount).toBe(1);
  });

  it("restores the pending journal record when a post-publication erasure transaction rolls back", async () => {
    const user = await store.createUser({ name: "Erasure Reconcile", authProvider: "apple" });
    const clock = () => 1_787_500_275_000;
    const published: Array<{ completedAt: number | null }> = [];
    const tombstones = {
      prepare: ({
        deletionRequestId,
        createdAt,
      }: {
        deletionRequestId: never;
        createdAt: number;
      }) => ({
        schemaVersion: 1 as const,
        deletionRequestId,
        userHmac: "a".repeat(64),
        hmacKeyVersion: "test",
        completedAt: null,
        expiresAt: createdAt + 31 * 24 * 60 * 60 * 1000,
        signatureVersion: 1 as const,
        signatureKeyVersion: "test",
        signature: "b".repeat(64),
      }),
      complete: (record: Record<string, unknown>, completedAt: number) => ({
        ...record,
        completedAt,
        expiresAt: completedAt + 31 * 24 * 60 * 60 * 1000,
        signature: "c".repeat(64),
      }),
      stageIntent: vi.fn(async () => undefined),
      publish: vi.fn(async (record: { completedAt: number | null }) => {
        published.push(record);
      }),
      discardIntent: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool, clock }),
      clock,
      undefined,
      tombstones as never,
    );
    const receipt = await deletions.request({ userId: user.id });
    await pool.query(`
      CREATE FUNCTION reject_local_erasure_after_journal() RETURNS trigger AS $$
      BEGIN
        IF NEW.state = 'locally_erased' THEN
          RAISE EXCEPTION 'forced post-journal erasure failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_local_erasure_after_journal
      BEFORE UPDATE ON account_deletion_request FOR EACH ROW
      EXECUTE FUNCTION reject_local_erasure_after_journal();
    `);
    try {
      await expect(deletions.eraseLocally(receipt.deletionRequestId)).rejects.toThrow(
        "forced post-journal erasure failure",
      );
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS reject_local_erasure_after_journal ON account_deletion_request;
        DROP FUNCTION IF EXISTS reject_local_erasure_after_journal();
      `);
    }
    expect(published.map((record) => record.completedAt)).toEqual([null, clock(), null]);
    await expect(deletions.load(receipt.deletionRequestId)).resolves.toMatchObject({
      state: "accepted",
    });
    expect((await pool.query("SELECT id FROM users WHERE id=$1", [user.id])).rowCount).toBe(1);
  });

  it("rolls local erasure back when the completed restore journal cannot be published", async () => {
    const user = await store.createUser({ name: "Retry Erasure", authProvider: "apple" });
    const clock = () => 1_787_500_300_000;
    const publish = vi.fn(async () => undefined);
    const tombstones = {
      prepare: ({
        deletionRequestId,
        createdAt,
      }: {
        deletionRequestId: never;
        createdAt: number;
      }) => ({
        schemaVersion: 1 as const,
        deletionRequestId,
        userHmac: "a".repeat(64),
        hmacKeyVersion: "test",
        completedAt: null,
        expiresAt: createdAt + 31 * 24 * 60 * 60 * 1000,
        signatureVersion: 1 as const,
        signatureKeyVersion: "test",
        signature: "b".repeat(64),
      }),
      complete: (record: Record<string, unknown>, completedAt: number) => ({
        ...record,
        completedAt,
        expiresAt: completedAt + 31 * 24 * 60 * 60 * 1000,
        signature: "c".repeat(64),
      }),
      stageIntent: vi.fn(async () => undefined),
      publish,
      discardIntent: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool, clock }),
      clock,
      undefined,
      tombstones as never,
    );
    const receipt = await deletions.request({ userId: user.id });
    publish.mockRejectedValueOnce(new Error("journal completion unavailable"));

    await expect(deletions.eraseLocally(receipt.deletionRequestId)).rejects.toThrow(
      "journal completion unavailable",
    );
    expect((await pool.query("SELECT id FROM users WHERE id=$1", [user.id])).rowCount).toBe(1);
    await expect(deletions.load(receipt.deletionRequestId)).resolves.toMatchObject({
      state: "accepted",
    });

    await expect(deletions.eraseLocally(receipt.deletionRequestId)).resolves.toBeUndefined();
    expect((await pool.query("SELECT id FROM users WHERE id=$1", [user.id])).rowCount).toBe(0);
  });
});
