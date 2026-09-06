import {
  createNotificationStore,
  createTokenCipher,
  parseTokenKeyring,
} from "@dont-text-your-ex/notifications";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type InviteCode,
  JarDetailSchema,
  NotificationIdSchema,
  PushInstallationIdSchema,
  ReportSchema,
} from "../../../../contracts";
import { pool } from "../db/index";
import { runMigrations } from "../db/migrate";
import { sanitizeEvidenceImage } from "../evidence-image";
import { PostgresOutbox } from "../outbox";
import { buildApp } from "../server";
import * as store from "../store";

// DB-integration suite: requires a real Postgres (DATABASE_URL). The default unit
// gate has no DB, so these skip and the hooks no-op; the db layer still imports
// (buildDatabaseUrl returns undefined when unconfigured rather than throwing).
// Locally: DATABASE_URL=postgresql://postgres:test@localhost:5432/tye_test bun run test --project dont-text-your-ex-api
const HAS_DB = !!process.env.DATABASE_URL;

const notificationStore = createNotificationStore(
  pool,
  createTokenCipher(
    parseTokenKeyring({
      activeKeyId: "test",
      keys: { test: Buffer.alloc(32, 3).toString("base64") },
    }),
  ),
  () => 1_750_000_000_000,
);

function requireInviteCode(detail: Awaited<ReturnType<typeof store.getJarDetail>>): InviteCode {
  if (!detail?.inviteCode) throw new Error("open jar invite missing");
  return detail.inviteCode;
}

function previewJar(token: string, code: string) {
  return buildApp().request("/api/jars/preview", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code }),
  });
}

beforeAll(async () => {
  if (!HAS_DB) return;
  await runMigrations();
});

beforeEach(async () => {
  if (!HAS_DB) return;
  // Truncate all tables in reverse dep order
  await pool.query(`
    TRUNCATE domain_event, jar_milestones, membership_tenures,
             report_evidence, reports, activity, slips, memberships,
             sessions, otps, user_exes, jars, users RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  if (!HAS_DB) return;
  await pool.end();
});

describe.skipIf(!HAS_DB)("users / auth", () => {
  it("creates a user and retrieves it", async () => {
    const u = await store.createUser({ name: "Alice", color: "#FF0000", exes: ["Bob"] });
    expect(u.id).toMatch(/^usr_/);
    expect(u.name).toBe("Alice");
    expect(u).not.toHaveProperty("exes");
    expect(await store.getMe(u.id)).toMatchObject({ exes: ["Bob"] });
  });

  it("creates a 30-day session and refreshes last-used time without extending expiry", async () => {
    const u = await store.createUser({ name: "Bob" });
    const token = await store.createSession(u.id);
    expect(token).toMatch(/^sess_/);
    const created = await pool.query<{
      created_at: string;
      expires_at: string;
      last_used_at: string;
    }>("SELECT created_at, expires_at, last_used_at FROM sessions WHERE token=$1", [token]);
    const metadata = created.rows[0];
    if (!metadata) throw new Error("created session metadata missing");
    expect(Number(metadata.expires_at) - Number(metadata.created_at)).toBe(30 * 86_400_000);

    await pool.query("UPDATE sessions SET last_used_at=$1 WHERE token=$2", [1, token]);
    const uid = await store.userIdForToken(token);
    expect(uid).toBe(u.id);
    const used = await pool.query<{ expires_at: string; last_used_at: string }>(
      "SELECT expires_at, last_used_at FROM sessions WHERE token=$1",
      [token],
    );
    expect(Number(used.rows[0]?.last_used_at)).toBeGreaterThan(1);
    expect(used.rows[0]?.expires_at).toBe(metadata.expires_at);
  });

  it("rejects and deletes an expired session", async () => {
    const u = await store.createUser({ name: "Carol" });
    const token = await store.createSession(u.id);
    await pool.query("UPDATE sessions SET expires_at=$1 WHERE token=$2", [Date.now() - 1, token]);
    const uid = await store.userIdForToken(token);
    expect(uid).toBeNull();
    const persisted = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions WHERE token=$1",
      [token],
    );
    expect(persisted.rows[0]?.count).toBe("0");
  });

  it("creates independent tokens and logout revokes only the current session", async () => {
    const u = await store.createUser({ name: "Multi-device User" });
    const first = await store.createSession(u.id);
    const second = await store.createSession(u.id);
    expect(first).not.toBe(second);

    const response = await buildApp().request("/api/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${first}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await store.userIdForToken(first)).toBeNull();
    expect(await store.userIdForToken(second)).toBe(u.id);
  });

  it("finds user by phone", async () => {
    await store.createUser({ name: "Dave", phone: "+15550000099" });
    const found = await store.findUserByPhone("+15550000099");
    expect(found?.name).toBe("Dave");
  });

  it("completes an unnamed Apple recovery profile with a user-entered name", async () => {
    const user = await store.createUser({
      name: "",
      appleId: "apple-user-123",
      authProvider: "apple",
    });

    const updated = await store.updateUser(user.id, { name: "Taylor" });

    expect(updated?.name).toBe("Taylor");
    expect((await store.findUserByAppleId("apple-user-123"))?.name).toBe("Taylor");
  });

  it("authenticates and validates device timezone refreshes", async () => {
    const user = await store.createUser({ name: "Timezone User" });
    const token = await store.createSession(user.id);
    const app = buildApp();

    const updated = await app.request("/api/me/timezone", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "Europe/London" }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ ok: true });
    expect(
      (await pool.query<{ timezone: string }>("SELECT timezone FROM users WHERE id=$1", [user.id]))
        .rows[0]?.timezone,
    ).toBe("Europe/London");

    const invalid = await app.request("/api/me/timezone", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "PST" }),
    });
    expect(invalid.status).toBe(400);
    const anonymous = await app.request("/api/me/timezone", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "UTC" }),
    });
    expect(anonymous.status).toBe(401);
  });
});

describe.skipIf(!HAS_DB)("authenticated notification delivery", () => {
  it("registers and disables only the current user's installation", async () => {
    const user = await store.createUser({ name: "Push User" });
    const other = await store.createUser({ name: "Other User" });
    const installationId = PushInstallationIdSchema.parse("dev_device1");
    await notificationStore.registerDevice(user.id, {
      installationId,
      token: "ab".repeat(32),
      platform: "ios",
      environment: "sandbox",
      appVersion: "1.0",
      appBuild: "24",
    });

    await notificationStore.disableDevice(other.id, installationId);
    const firstNotification = NotificationIdSchema.parse("ntf_11111111111111111111111111111111");
    await pool.query(
      `INSERT INTO user_notification
       (id,recipient_user_id,category,dedupe_key,target_type,message_key,created_at)
       VALUES ($1,$2,'report','first','activity','reports.pending',$3)`,
      [firstNotification, user.id, 1_750_000_000_000],
    );
    expect(await notificationStore.prepareDeliveries(firstNotification)).toHaveLength(1);

    await notificationStore.disableDevice(user.id, installationId);
    const secondNotification = NotificationIdSchema.parse("ntf_22222222222222222222222222222222");
    await pool.query(
      `INSERT INTO user_notification
       (id,recipient_user_id,category,dedupe_key,target_type,message_key,created_at)
       VALUES ($1,$2,'report','second','activity','reports.pending',$3)`,
      [secondNotification, user.id, 1_750_000_000_000],
    );
    expect(await notificationStore.prepareDeliveries(secondNotification)).toEqual([]);
  });

  it("replays an accepted delivery as delivered without exposing the device token", async () => {
    const user = await store.createUser({ name: "Replay User" });
    const installationId = PushInstallationIdSchema.parse("dev_replay");
    await notificationStore.registerDevice(user.id, {
      installationId,
      token: "ac".repeat(32),
      platform: "ios",
      environment: "sandbox",
      appVersion: "1.0",
      appBuild: "24",
    });
    const notificationId = NotificationIdSchema.parse("ntf_55555555555555555555555555555555");
    await pool.query(
      `INSERT INTO user_notification
       (id,recipient_user_id,category,dedupe_key,target_type,message_key,created_at)
       VALUES ($1,$2,'report','accepted-replay','activity','reports.pending',$3)`,
      [notificationId, user.id, 1_750_000_000_000],
    );
    const [deliveryId] = await notificationStore.prepareDeliveries(notificationId);
    if (!deliveryId) throw new Error("delivery was not prepared");

    await notificationStore.recordDeliveryOutcome(deliveryId, {
      kind: "accepted",
      apnsId: "accepted-by-apns",
    });

    await expect(notificationStore.loadDelivery(deliveryId)).resolves.toEqual({
      kind: "terminal",
      state: "delivered",
    });
  });

  it("applies safe defaults and persists authenticated preference patches", async () => {
    const user = await store.createUser({ name: "Preference User" });
    const token = await store.createSession(user.id);
    const app = buildApp();

    const defaults = await app.request("/api/me/notification-preferences", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await defaults.json()).toMatchObject({ report: true, rescue: true, slip: false });

    const patched = await app.request("/api/me/notification-preferences", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ report: false, slip: true }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ report: false, rescue: true, slip: true });
  });

  it("re-encrypts device tokens in bounded batches before old-key retirement", async () => {
    const user = await store.createUser({ name: "Rotation User" });
    const oldKey = Buffer.alloc(32, 1).toString("base64");
    const newKey = Buffer.alloc(32, 2).toString("base64");
    const oldStore = createNotificationStore(
      pool,
      createTokenCipher(parseTokenKeyring({ activeKeyId: "old", keys: { old: oldKey } })),
      () => 1_750_000_000_000,
    );
    const installationId = PushInstallationIdSchema.parse("dev_rotation");
    await oldStore.registerDevice(user.id, {
      installationId,
      token: "ef".repeat(32),
      platform: "ios",
      environment: "sandbox",
      appVersion: "1.0",
      appBuild: "24",
    });
    const rotatingStore = createNotificationStore(
      pool,
      createTokenCipher(
        parseTokenKeyring({ activeKeyId: "new", keys: { old: oldKey, new: newKey } }),
      ),
      () => 1_750_000_000_000,
    );

    await expect(rotatingStore.rotateTokenBatch(100)).resolves.toBe(1);
    await expect(rotatingStore.rotateTokenBatch(100)).resolves.toBe(0);
    const persisted = await pool.query<{ token_key_id: string }>(
      "SELECT token_key_id FROM push_device WHERE installation_id=$1",
      [installationId],
    );
    expect(persisted.rows[0]?.token_key_id).toBe("new");
  });

  it("suppresses a prepared delivery after a late opt-out and never overwrites terminal state", async () => {
    const user = await store.createUser({ name: "Late Opt Out" });
    const installationId = PushInstallationIdSchema.parse("dev_lateoptout");
    await notificationStore.registerDevice(user.id, {
      installationId,
      token: "cd".repeat(32),
      platform: "ios",
      environment: "sandbox",
      appVersion: "1.0",
      appBuild: "24",
    });
    const notificationId = NotificationIdSchema.parse("ntf_44444444444444444444444444444444");
    await pool.query(
      `INSERT INTO user_notification
       (id,recipient_user_id,category,dedupe_key,target_type,message_key,created_at)
       VALUES ($1,$2,'report','late-opt-out','activity','reports.pending',$3)`,
      [notificationId, user.id, 1_750_000_000_000],
    );
    const [deliveryId] = await notificationStore.prepareDeliveries(notificationId);
    if (!deliveryId) throw new Error("delivery was not prepared");
    await notificationStore.updatePreferences(user.id, { report: false });

    await expect(notificationStore.loadDelivery(deliveryId)).resolves.toEqual({
      kind: "terminal",
      state: "suppressed",
    });
    expect(
      (
        await pool.query<{ status: string }>(
          "SELECT status FROM notification_delivery WHERE id=$1",
          [deliveryId],
        )
      ).rows[0]?.status,
    ).toBe("suppressed");

    await notificationStore.recordDeliveryOutcome(deliveryId, { kind: "accepted", apnsId: "late" });
    expect(
      (
        await pool.query<{ status: string }>(
          "SELECT status FROM notification_delivery WHERE id=$1",
          [deliveryId],
        )
      ).rows[0]?.status,
    ).toBe("suppressed");
  });

  it("reveals a target only to its recipient", async () => {
    const recipient = await store.createUser({ name: "Recipient" });
    const stranger = await store.createUser({ name: "Stranger" });
    const recipientToken = await store.createSession(recipient.id);
    const strangerToken = await store.createSession(stranger.id);
    const notificationId = NotificationIdSchema.parse("ntf_33333333333333333333333333333333");
    await pool.query(
      `INSERT INTO user_notification
       (id,recipient_user_id,category,dedupe_key,target_type,message_key,created_at)
       VALUES ($1,$2,'report','private','profile','reports.pending',$3)`,
      [notificationId, recipient.id, 1_750_000_000_000],
    );
    const app = buildApp();

    const allowed = await app.request(`/api/notifications/${notificationId}/target`, {
      headers: { Authorization: `Bearer ${recipientToken}` },
    });
    const hidden = await app.request(`/api/notifications/${notificationId}/target`, {
      headers: { Authorization: `Bearer ${strangerToken}` },
    });
    expect(await allowed.json()).toEqual({ type: "profile" });
    expect(await hidden.json()).toEqual({ type: "unavailable" });
  });
});

describe.skipIf(!HAS_DB)("jar lifecycle", () => {
  it("rolls back the jar and invite when owner membership creation fails", async () => {
    const owner = await store.createUser({ name: "Rollback Owner" });
    const joiner = await store.createUser({ name: "Rollback Joiner" });
    const ownerToken = await store.createSession(owner.id);
    const joinerToken = await store.createSession(joiner.id);
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_owner_membership() RETURNS trigger AS $$
      BEGIN
        IF NEW.role = 'owner' THEN RAISE EXCEPTION 'forced owner membership failure'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS fail_owner_membership ON memberships;
      CREATE TRIGGER fail_owner_membership BEFORE INSERT ON memberships
      FOR EACH ROW EXECUTE FUNCTION fail_owner_membership();
    `);

    try {
      const response = await buildApp().request("/api/jars", {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Must Roll Back" }),
      });
      expect(response.status).toBe(500);

      const persisted = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM jars WHERE name=$1 OR invite_code=$2",
        ["Must Roll Back", "AAAAAA"],
      );
      expect(persisted.rows[0]?.count).toBe("0");
      expect((await previewJar(joinerToken, "AAAAAA")).status).toBe(404);
      expect(
        (
          await buildApp().request("/api/jars/join", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${joinerToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ code: "AAAAAA" }),
          })
        ).status,
      ).toBe(404);
    } finally {
      random.mockRestore();
      await pool.query("DROP TRIGGER IF EXISTS fail_owner_membership ON memberships");
      await pool.query("DROP FUNCTION IF EXISTS fail_owner_membership()");
    }
  });

  it("starts new owner and member streak sharing as private", async () => {
    const owner = await store.createUser({ name: "Private Owner" });
    const member = await store.createUser({ name: "Private Member" });
    const jar = await store.createJar({ userId: owner.id, name: "Opt-in Jar" });
    expect(jar.myShareStreak).toBe(false);

    const detail = await store.getJarDetail(jar.id, owner.id);
    if (!detail) throw new Error("created opt-in jar detail missing");
    await store.joinJarByCode(member.id, requireInviteCode(detail));

    const memberJars = await store.listJarsForUser(member.id);
    expect(memberJars.find((entry) => entry.id === jar.id)?.myShareStreak).toBe(false);
  });

  it("creates jar and lists for user", async () => {
    const u = await store.createUser({ name: "Eve" });
    const jar = await store.createJar({ userId: u.id, name: "Test Jar", rule: "no texting" });
    expect(jar.id).toMatch(/^jar_/);
    const list = await store.listJarsForUser(u.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(jar.id);
  });

  it("join jar by code", async () => {
    const owner = await store.createUser({ name: "Frank" });
    const jar = await store.createJar({ userId: owner.id, name: "Shared Jar", rule: "" });
    const detail = await store.getJarDetail(jar.id, owner.id);
    expect(detail).not.toBeNull();
    if (!detail) throw new Error("created jar detail missing");
    const code = requireInviteCode(detail);

    const joiner = await store.createUser({ name: "Grace" });
    const preview = await store.getJarPreviewByCode(code, joiner.id);
    expect(preview?.members).toEqual([expect.objectContaining({ id: owner.id, name: "Frank" })]);
    expect(preview?.members[0]).not.toHaveProperty("exes");

    const result = await store.joinJarByCode(joiner.id, code);
    expect(result).not.toBeNull();
    expect(result?.jarId).toBe(jar.id);

    const joinedDetail = await store.getJarDetail(jar.id, owner.id);
    expect(joinedDetail?.members).toHaveLength(2);
  });

  it("expires invites after seven days and lets only the owner replace them", async () => {
    const owner = await store.createUser({ name: "Invite Owner" });
    const member = await store.createUser({ name: "Invite Member" });
    const former = await store.createUser({ name: "Former Member" });
    const outsider = await store.createUser({ name: "Invite Outsider" });
    const jar = await store.createJar({ userId: owner.id, name: "Expiring Invite" });
    const original = await store.getJarDetail(jar.id, owner.id);
    const originalCode = requireInviteCode(original);
    await store.joinJarByCode(member.id, originalCode);
    await store.joinJarByCode(former.id, originalCode);
    await store.leaveJar(jar.id, former.id);

    const ownerToken = await store.createSession(owner.id);
    const memberToken = await store.createSession(member.id);
    const formerToken = await store.createSession(former.id);
    const outsiderToken = await store.createSession(outsider.id);
    const rotate = (token: string, confirmed = true) =>
      buildApp().request(`/api/jars/${jar.id}/invite/rotate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed }),
      });

    expect((await rotate(ownerToken, false)).status).toBe(400);
    expect((await rotate(memberToken)).status).toBe(403);
    expect((await rotate(formerToken)).status).toBe(404);
    expect((await rotate(outsiderToken)).status).toBe(404);

    const rotatedResponse = await rotate(ownerToken);
    expect(rotatedResponse.status).toBe(200);
    const rotated = JarDetailSchema.parse(await rotatedResponse.json());
    expect(rotated.inviteCode).not.toBe(originalCode);
    expect(rotated.inviteExpiresAt).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(rotated.inviteExpiresAt).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);

    for (const token of [ownerToken, memberToken, formerToken, outsiderToken]) {
      const oldPreview = await previewJar(token, originalCode);
      expect(oldPreview.status).toBe(404);
      const oldJoin = await buildApp().request("/api/jars/join", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ code: originalCode }),
      });
      expect(oldJoin.status).toBe(404);
    }

    const newCode = requireInviteCode(rotated);
    expect((await previewJar(outsiderToken, newCode)).status).toBe(200);
    expect(
      (
        await buildApp().request("/api/jars/join", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${outsiderToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ code: newCode }),
        })
      ).status,
    ).toBe(200);

    await pool.query("UPDATE jars SET invite_expires_at=$1 WHERE id=$2", [Date.now() - 1, jar.id]);
    const expiredPreview = await previewJar(ownerToken, newCode);
    expect(expiredPreview.status).toBe(404);
    const expiredJoin = await buildApp().request("/api/jars/join", {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code: newCode }),
    });
    expect(expiredJoin.status).toBe(404);

    const replacementAfterReload = await rotate(ownerToken);
    expect(replacementAfterReload.status).toBe(200);
    const reloaded = await store.getJarDetail(jar.id, owner.id);
    expect(reloaded?.inviteCode).not.toBe(newCode);
    expect(reloaded?.inviteExpiresAt).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    await store.closeJar(jar.id, owner.id);
    const closedRotation = await rotate(ownerToken);
    expect(closedRotation.status).toBe(409);
    expect(await closedRotation.json()).toEqual({ error: "jar_closed" });
  });

  it("does not admit a join after concurrent close or invite rotation has locked invalidation", async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION delay_invite_invalidation() RETURNS trigger AS $$
      BEGIN
        IF OLD.invite_code IS DISTINCT FROM NEW.invite_code THEN PERFORM pg_sleep(0.4); END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS delay_invite_invalidation ON jars;
      CREATE TRIGGER delay_invite_invalidation BEFORE UPDATE ON jars
      FOR EACH ROW EXECUTE FUNCTION delay_invite_invalidation();
    `);

    const waitForInvalidationLock = async () => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const sleeping = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM pg_stat_activity
           WHERE wait_event='PgSleep' AND query LIKE 'UPDATE jars SET%'`,
        );
        if (sleeping.rows[0]?.count !== "0") return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("invite invalidation did not acquire its database lock");
    };

    try {
      for (const action of ["close", "rotate"] as const) {
        const owner = await store.createUser({ name: `${action} owner` });
        const joiner = await store.createUser({ name: `${action} joiner` });
        const jar = await store.createJar({ userId: owner.id, name: `${action} race` });
        const detail = await store.getJarDetail(jar.id, owner.id);
        const oldCode = requireInviteCode(detail);
        const ownerToken = await store.createSession(owner.id);
        const joinerToken = await store.createSession(joiner.id);

        const invalidation = buildApp().request(
          action === "close" ? `/api/jars/${jar.id}/close` : `/api/jars/${jar.id}/invite/rotate`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${ownerToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ confirmed: true }),
          },
        );
        await waitForInvalidationLock();
        const join = buildApp().request("/api/jars/join", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${joinerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ code: oldCode }),
        });

        expect((await invalidation).status).toBe(200);
        expect((await join).status).toBe(404);
        expect(await store.isMember(jar.id, joiner.id)).toBe(false);
      }
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS delay_invite_invalidation ON jars");
      await pool.query("DROP FUNCTION IF EXISTS delay_invite_invalidation()");
    }
  });

  it("lets only the owner close a jar, persists closure, and revokes its invite", async () => {
    const owner = await store.createUser({ name: "Close Owner" });
    const member = await store.createUser({ name: "Close Member" });
    const jar = await store.createJar({ userId: owner.id, name: "Finite Jar" });
    const openDetail = await store.getJarDetail(jar.id, owner.id);
    if (!openDetail?.inviteCode) throw new Error("open jar invite missing");
    await store.joinJarByCode(member.id, openDetail.inviteCode);

    await expect(store.closeJar(jar.id, member.id)).resolves.toEqual({ status: "forbidden" });
    const ownerToken = await store.createSession(owner.id);
    const memberToken = await store.createSession(member.id);
    const unconfirmed = await buildApp().request(`/api/jars/${jar.id}/close`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: false }),
    });
    expect(unconfirmed.status).toBe(400);
    const forbidden = await buildApp().request(`/api/jars/${jar.id}/close`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    expect(forbidden.status).toBe(403);
    const closed = await buildApp().request(`/api/jars/${jar.id}/close`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    expect(closed.status).toBe(200);
    expect(JarDetailSchema.parse(await closed.json()).closedBy?.id).toBe(owner.id);

    const reloaded = await store.getJarDetail(jar.id, owner.id);
    expect(reloaded).toEqual(
      expect.objectContaining({
        id: jar.id,
        closedAt: expect.any(Number),
        closedBy: expect.objectContaining({ id: owner.id }),
        inviteCode: null,
      }),
    );
    expect(reloaded?.members).toHaveLength(2);
    expect(await store.getJarPreviewByCode(openDetail.inviteCode, owner.id)).toBeNull();
    expect(
      await store.joinJarByCode(
        (await store.createUser({ name: "Late Joiner" })).id,
        openDetail.inviteCode,
      ),
    ).toBeNull();
  });

  it("rejects every jar mutation after closure while preserving history", async () => {
    const owner = await store.createUser({ name: "Archive Owner" });
    const accused = await store.createUser({ name: "Archive Accused" });
    const jar = await store.createJar({ userId: owner.id, name: "Archive Jar" });
    const detail = await store.getJarDetail(jar.id, owner.id);
    if (!detail?.inviteCode) throw new Error("open jar invite missing");
    await store.joinJarByCode(accused.id, detail.inviteCode);
    await store.logSlip({ jarId: jar.id, userId: owner.id, amountCents: 500 });
    const report = await store.createReport({
      jarId: jar.id,
      accuserId: owner.id,
      accusedId: accused.id,
      note: "Before close",
      anonymous: false,
      amountCents: 500,
      evidence: [],
    });
    await store.closeJar(jar.id, owner.id);

    expect(await store.pendingReportsForUser(accused.id)).toEqual([]);

    const ownerToken = await store.createSession(owner.id);
    const slipResponse = await buildApp().request(`/api/jars/${jar.id}/slips`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amountCents: 500 }),
    });
    expect(slipResponse.status).toBe(409);
    expect(await slipResponse.json()).toEqual({ error: "jar_closed" });

    await expect(
      store.logSlip({ jarId: jar.id, userId: owner.id, amountCents: 500 }),
    ).rejects.toThrow("jar is closed");
    await expect(store.setShareStreak(jar.id, owner.id, true)).rejects.toThrow("jar is closed");
    await expect(
      store.createReport({
        jarId: jar.id,
        accuserId: owner.id,
        accusedId: accused.id,
        note: "After close",
        anonymous: false,
        amountCents: 500,
        evidence: [],
      }),
    ).rejects.toThrow("jar is closed");
    await expect(store.resolveReport(report.id, accused.id, "own")).rejects.toThrow(
      "jar is closed",
    );

    const history = await store.getJarDetail(jar.id, owner.id);
    expect(history?.jarTotalCents).toBe(500);
    expect(history?.activity.length).toBeGreaterThan(0);
  });

  it("lets members leave without erasing history and requires owners to close", async () => {
    const owner = await store.createUser({ name: "Stay Owner" });
    const member = await store.createUser({ name: "Leaving Member" });
    const outsider = await store.createUser({ name: "Leave Outsider" });
    const jar = await store.createJar({ userId: owner.id, name: "Leave Jar" });
    const detail = await store.getJarDetail(jar.id, owner.id);
    const code = requireInviteCode(detail);
    await store.joinJarByCode(member.id, code);
    await store.logSlip({ jarId: jar.id, userId: member.id, amountCents: 700 });
    await store.createReport({
      jarId: jar.id,
      accuserId: owner.id,
      accusedId: member.id,
      note: "Pending before leave",
      anonymous: false,
      amountCents: 500,
      evidence: [],
    });

    await expect(store.leaveJar(jar.id, owner.id)).resolves.toEqual({
      status: "owner_must_close",
    });
    const ownerToken = await store.createSession(owner.id);
    const memberToken = await store.createSession(member.id);
    const outsiderToken = await store.createSession(outsider.id);
    const unconfirmed = await buildApp().request(`/api/jars/${jar.id}/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: false }),
    });
    expect(unconfirmed.status).toBe(400);
    const ownerCannotLeave = await buildApp().request(`/api/jars/${jar.id}/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    expect(ownerCannotLeave.status).toBe(409);
    expect(await ownerCannotLeave.json()).toEqual({ error: "owner_must_close" });
    const outsiderCannotLeave = await buildApp().request(`/api/jars/${jar.id}/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${outsiderToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    expect(outsiderCannotLeave.status).toBe(404);
    expect(await outsiderCannotLeave.json()).toEqual({ error: "not_found" });
    const leave = await buildApp().request(`/api/jars/${jar.id}/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    expect(leave.status).toBe(200);
    expect(await leave.json()).toEqual({ ok: true });

    expect(await store.isMember(jar.id, member.id)).toBe(false);
    expect(await store.listJarsForUser(member.id)).toHaveLength(0);
    expect(await store.activityForUser(member.id)).toEqual([]);
    expect(await store.pendingReportsForUser(member.id)).toEqual([]);
    expect(await store.getJarPreviewByCode(code, member.id)).toMatchObject({
      memberCount: 1,
      members: [expect.objectContaining({ id: owner.id })],
    });
    const ownerHome = await store.listJarsForUser(owner.id);
    expect(ownerHome[0]).toMatchObject({
      memberCount: 1,
      memberIds: [owner.id],
      jarTotalCents: 700,
    });
    const ownerHistory = await store.getJarDetail(jar.id, owner.id);
    expect(ownerHistory?.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user: expect.objectContaining({ id: member.id }),
          tallyCents: 700,
          active: false,
        }),
        expect.objectContaining({
          user: expect.objectContaining({ id: owner.id }),
          active: true,
        }),
      ]),
    );
    const ownerDetailResponse = await buildApp().request(`/api/jars/${jar.id}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerDetailResponse.status).toBe(200);
    const rawOwnerDetail = JarDetailSchema.parse(await ownerDetailResponse.json());
    expect(rawOwnerDetail.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user: expect.objectContaining({ id: member.id }),
          active: false,
        }),
        expect.objectContaining({ user: expect.objectContaining({ id: owner.id }), active: true }),
      ]),
    );
    const reportFormer = await buildApp().request(`/api/jars/${jar.id}/reports`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ accusedId: member.id, note: "Former member must not be reportable" }),
    });
    expect(reportFormer.status).toBe(400);
    expect(await reportFormer.json()).toEqual({ error: "bad_target" });
    const denied = await buildApp().request(`/api/jars/${jar.id}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "not_found" });

    await expect(store.joinJarByCode(member.id, code)).resolves.toEqual({ jarId: jar.id });
    expect(await store.isMember(jar.id, member.id)).toBe(true);
    const rejoined = await store.getJarDetail(jar.id, member.id);
    expect(rejoined?.members.find((entry) => entry.user.id === member.id)).toMatchObject({
      active: true,
      tallyCents: 700,
    });
    expect(await store.listJarsForUser(member.id)).toEqual([
      expect.objectContaining({ id: jar.id, myTallyCents: 700, memberCount: 2 }),
    ]);
    expect(await store.pendingReportsForUser(member.id)).toEqual([
      expect.objectContaining({ accused: expect.objectContaining({ id: member.id }) }),
    ]);
  });

  it("hides a member's private streak from other members and rejects outsiders", async () => {
    const owner = await store.createUser({ name: "Streak Owner" });
    const member = await store.createUser({ name: "Jar Member" });
    const outsider = await store.createUser({ name: "Outsider" });
    const jar = await store.createJar({ userId: owner.id, name: "Private Streak Jar" });
    const ownerDetail = await store.getJarDetail(jar.id, owner.id);
    if (!ownerDetail) throw new Error("created private streak jar detail missing");
    await store.joinJarByCode(member.id, requireInviteCode(ownerDetail));
    await store.setShareStreak(jar.id, owner.id, false);
    await store.logSlip({ jarId: jar.id, userId: owner.id, amountCents: 500 });

    const memberToken = await store.createSession(member.id);
    const memberResponse = await buildApp().request(`/api/jars/${jar.id}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(memberResponse.status).toBe(200);
    const memberView = JarDetailSchema.parse(await memberResponse.json());
    const privateMember = memberView.members.find((entry) => entry.user.id === owner.id);
    expect(privateMember).toBeDefined();
    expect(JSON.parse(JSON.stringify(privateMember))).not.toHaveProperty("daysClean");

    const ownerView = await store.getJarDetail(jar.id, owner.id);
    expect(ownerView?.members.find((entry) => entry.user.id === owner.id)).toHaveProperty(
      "daysClean",
      0,
    );

    const outsiderToken = await store.createSession(outsider.id);
    const response = await buildApp().request(`/api/jars/${jar.id}`, {
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});

describe.skipIf(!HAS_DB)("slip logging", () => {
  it("logs a slip and updates tally", async () => {
    const u = await store.createUser({ name: "Henry" });
    const jar = await store.createJar({
      userId: u.id,
      name: "Slip Jar",
      rule: "",
      defaultCents: 500,
    });
    await store.logSlip({ jarId: jar.id, userId: u.id, amountCents: 500, note: null });
    const list = await store.listJarsForUser(u.id);
    expect(list[0].myTallyCents).toBe(500);
  });
});

describe.skipIf(!HAS_DB)("reports", () => {
  it("rejects reporting oneself without persisting a report", async () => {
    const user = await store.createUser({ name: "Self Reporter" });
    const jar = await store.createJar({ userId: user.id, name: "Self Report Jar" });
    const token = await store.createSession(user.id);

    const response = await buildApp().request(`/api/jars/${jar.id}/reports`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accusedId: user.id, note: "reported myself" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "cannot_report_self" });
    const persisted = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM reports",
    );
    expect(persisted.rows[0]?.count).toBe("0");
  });

  it("persists image evidence, creates a pending report, and resolves as owned", async () => {
    const accuser = await store.createUser({ name: "Iris" });
    const accused = await store.createUser({ name: "Jack" });
    const jar = await store.createJar({ userId: accuser.id, name: "Report Jar", rule: "" });
    const detail = await store.getJarDetail(jar.id, accuser.id);
    if (!detail) throw new Error("created report jar detail missing");
    await store.joinJarByCode(accused.id, requireInviteCode(detail));

    const report = await store.createReport({
      jarId: jar.id,
      accuserId: accuser.id,
      accusedId: accused.id,
      note: "saw it",
      anonymous: false,
      amountCents: 500,
      evidence: [
        sanitizeEvidenceImage({
          mimeType: "image/png",
          dataUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        }),
      ],
    });
    expect(report.status).toBe("pending");
    expect(report.evidence).toEqual([
      expect.objectContaining({
        kind: "image",
        mimeType: "image/png",
        dataUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      }),
    ]);

    const pending = await store.pendingReportsForUser(accused.id);
    expect(pending).toHaveLength(1);

    const resolved = await store.resolveReport(report.id, accused.id, "own");
    expect(resolved?.status).toBe("owned");

    const jars = await store.listJarsForUser(accused.id);
    expect(jars.find((j) => j.id === jar.id)?.myTallyCents).toBe(500);
  });

  it("rejects malformed evidence atomically before creating a report", async () => {
    const accuser = await store.createUser({ name: "Safe Evidence Reporter" });
    const accused = await store.createUser({ name: "Safe Evidence Accused" });
    const jar = await store.createJar({ userId: accuser.id, name: "Safe Evidence Jar" });
    await store.joinJarByCode(
      accused.id,
      requireInviteCode(await store.getJarDetail(jar.id, accuser.id)),
    );
    const token = await store.createSession(accuser.id);

    const response = await buildApp().request(`/api/jars/${jar.id}/reports`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        accusedId: accused.id,
        evidence: [
          {
            mimeType: "image/png",
            dataUrl:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          },
          { mimeType: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
        ],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    for (const table of ["reports", "report_evidence"] as const) {
      const persisted = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${table}`,
      );
      expect(persisted.rows[0]?.count, table).toBe("0");
    }
  });

  it("omits unsafe legacy evidence instead of rendering its original bytes", async () => {
    const accuser = await store.createUser({ name: "Legacy Evidence Reporter" });
    const accused = await store.createUser({ name: "Legacy Evidence Accused" });
    const jar = await store.createJar({ userId: accuser.id, name: "Legacy Evidence Jar" });
    await store.joinJarByCode(
      accused.id,
      requireInviteCode(await store.getJarDetail(jar.id, accuser.id)),
    );
    const report = await store.createReport({
      jarId: jar.id,
      accuserId: accuser.id,
      accusedId: accused.id,
      note: "legacy attachment",
      anonymous: false,
      amountCents: 500,
      evidence: [
        sanitizeEvidenceImage({
          mimeType: "image/png",
          dataUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        }),
      ],
    });
    await pool.query("UPDATE report_evidence SET payload=$1 WHERE report_id=$2", [
      JSON.stringify({ mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,/9j/AA==" }),
      report.id,
    ]);

    await expect(store.reportForUser(report.id, accused.id)).resolves.toMatchObject({
      id: report.id,
      evidence: [],
    });
  });

  it("rolls back a failed authenticated report creation without partial evidence", async () => {
    const accuser = await store.createUser({ name: "Atomic Reporter" });
    const accused = await store.createUser({ name: "Atomic Accused" });
    const jar = await store.createJar({ userId: accuser.id, name: "Atomic Create Jar" });
    await store.joinJarByCode(
      accused.id,
      requireInviteCode(await store.getJarDetail(jar.id, accuser.id)),
    );
    const token = await store.createSession(accuser.id);
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_atomic_report_activity() RETURNS trigger AS $$
      BEGIN
        IF NEW.type = 'report' AND NEW.note = 'rollback creation' THEN
          RAISE EXCEPTION 'forced report activity failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS fail_atomic_report_activity ON activity;
      CREATE TRIGGER fail_atomic_report_activity BEFORE INSERT ON activity
      FOR EACH ROW EXECUTE FUNCTION fail_atomic_report_activity();
    `);

    try {
      const response = await buildApp().request(`/api/jars/${jar.id}/reports`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          accusedId: accused.id,
          note: "rollback creation",
          evidence: [
            {
              mimeType: "image/png",
              dataUrl:
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            },
          ],
        }),
      });
      expect(response.status).toBe(500);
      for (const table of ["reports", "report_evidence"] as const) {
        const persisted = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${table}`,
        );
        expect(persisted.rows[0]?.count, table).toBe("0");
      }
      const reportActivity = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM activity WHERE type='report' AND note='rollback creation'",
      );
      expect(reportActivity.rows[0]?.count).toBe("0");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS fail_atomic_report_activity ON activity");
      await pool.query("DROP FUNCTION IF EXISTS fail_atomic_report_activity()");
    }
  });

  it("owns a report exactly once under concurrent authenticated requests", async () => {
    const accuser = await store.createUser({ name: "Concurrent Reporter" });
    const accused = await store.createUser({ name: "Concurrent Accused" });
    const jar = await store.createJar({ userId: accuser.id, name: "Concurrent Resolve Jar" });
    await store.joinJarByCode(
      accused.id,
      requireInviteCode(await store.getJarDetail(jar.id, accuser.id)),
    );
    const report = await store.createReport({
      jarId: jar.id,
      accuserId: accuser.id,
      accusedId: accused.id,
      note: "exactly once",
      anonymous: false,
      amountCents: 500,
      evidence: [],
    });
    const token = await store.createSession(accused.id);
    await pool.query(`
      CREATE OR REPLACE FUNCTION delay_report_slip() RETURNS trigger AS $$
      BEGIN
        IF NEW.source = 'report' THEN PERFORM pg_sleep(0.2); END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS delay_report_slip ON slips;
      CREATE TRIGGER delay_report_slip BEFORE INSERT ON slips
      FOR EACH ROW EXECUTE FUNCTION delay_report_slip();
    `);

    try {
      const resolve = () =>
        buildApp().request(`/api/reports/${report.id}/resolve`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action: "own" }),
        });
      const responses = await Promise.all([resolve(), resolve()]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 404]);

      const persisted = await pool.query<{
        report_status: string;
        slip_count: string;
        tally_cents: number;
        activity_count: string;
      }>(
        `SELECT
          (SELECT status FROM reports WHERE id=$1) AS report_status,
          (SELECT COUNT(*)::text FROM slips WHERE source='report' AND user_id=$2) AS slip_count,
          (SELECT tally_cents FROM memberships WHERE jar_id=$3 AND user_id=$2) AS tally_cents,
          (SELECT COUNT(*)::text FROM activity WHERE type='slip' AND report_id=$1) AS activity_count`,
        [report.id, accused.id, jar.id],
      );
      expect(persisted.rows[0]).toEqual({
        report_status: "owned",
        slip_count: "1",
        tally_cents: 500,
        activity_count: "1",
      });
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS delay_report_slip ON slips");
      await pool.query("DROP FUNCTION IF EXISTS delay_report_slip()");
    }
  });

  it("rolls back a failed own resolution and succeeds exactly once on retry", async () => {
    const accuser = await store.createUser({ name: "Own Rollback Reporter" });
    const accused = await store.createUser({ name: "Own Rollback Accused" });
    const jar = await store.createJar({ userId: accuser.id, name: "Own Rollback Jar" });
    await store.joinJarByCode(
      accused.id,
      requireInviteCode(await store.getJarDetail(jar.id, accuser.id)),
    );
    const report = await store.createReport({
      jarId: jar.id,
      accuserId: accuser.id,
      accusedId: accused.id,
      note: "rollback own resolution",
      anonymous: false,
      amountCents: 500,
      evidence: [],
    });
    const accuserToken = await store.createSession(accuser.id);
    const accusedToken = await store.createSession(accused.id);
    const resolve = (token: string) =>
      buildApp().request(`/api/reports/${report.id}/resolve`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "own" }),
      });

    expect((await resolve(accuserToken)).status).toBe(404);
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_owned_report_status() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'owned' AND OLD.note = 'rollback own resolution' THEN
          RAISE EXCEPTION 'forced owned report status failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS fail_owned_report_status ON reports;
      CREATE TRIGGER fail_owned_report_status BEFORE UPDATE ON reports
      FOR EACH ROW EXECUTE FUNCTION fail_owned_report_status();
    `);

    try {
      expect((await resolve(accusedToken)).status).toBe(500);
      const rolledBack = await pool.query<{
        status: string;
        slip_count: string;
        tally_cents: number;
        activity_count: string;
      }>(
        `SELECT
          (SELECT status FROM reports WHERE id=$1) AS status,
          (SELECT COUNT(*)::text FROM slips WHERE source='report' AND user_id=$2) AS slip_count,
          (SELECT tally_cents FROM memberships WHERE jar_id=$3 AND user_id=$2) AS tally_cents,
          (SELECT COUNT(*)::text FROM activity WHERE type='slip' AND report_id=$1) AS activity_count`,
        [report.id, accused.id, jar.id],
      );
      expect(rolledBack.rows[0]).toEqual({
        status: "pending",
        slip_count: "0",
        tally_cents: 0,
        activity_count: "0",
      });
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS fail_owned_report_status ON reports");
      await pool.query("DROP FUNCTION IF EXISTS fail_owned_report_status()");
    }

    expect((await resolve(accusedToken)).status).toBe(200);
    expect((await resolve(accusedToken)).status).toBe(404);
    const reloaded = await buildApp().request(`/api/reports/${report.id}`, {
      headers: { Authorization: `Bearer ${accusedToken}` },
    });
    expect(reloaded.status).toBe(200);
    expect(ReportSchema.parse(await reloaded.json()).status).toBe("owned");
  });

  it("rolls back a failed deny resolution and preserves authorization and retry semantics", async () => {
    const accuser = await store.createUser({ name: "Deny Rollback Reporter" });
    const accused = await store.createUser({ name: "Deny Rollback Accused" });
    const jar = await store.createJar({ userId: accuser.id, name: "Deny Rollback Jar" });
    await store.joinJarByCode(
      accused.id,
      requireInviteCode(await store.getJarDetail(jar.id, accuser.id)),
    );
    const report = await store.createReport({
      jarId: jar.id,
      accuserId: accuser.id,
      accusedId: accused.id,
      note: "rollback deny resolution",
      anonymous: false,
      amountCents: 500,
      evidence: [],
    });
    const accuserToken = await store.createSession(accuser.id);
    const accusedToken = await store.createSession(accused.id);
    const resolve = (token: string) =>
      buildApp().request(`/api/reports/${report.id}/resolve`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "deny" }),
      });

    expect((await resolve(accuserToken)).status).toBe(404);
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_deny_report_activity() RETURNS trigger AS $$
      BEGIN
        IF NEW.type = 'deny' AND NEW.report_id IS NOT NULL THEN
          RAISE EXCEPTION 'forced deny report activity failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS fail_deny_report_activity ON activity;
      CREATE TRIGGER fail_deny_report_activity BEFORE INSERT ON activity
      FOR EACH ROW EXECUTE FUNCTION fail_deny_report_activity();
    `);

    try {
      expect((await resolve(accusedToken)).status).toBe(500);
      const rolledBack = await pool.query<{ status: string; activity_count: string }>(
        `SELECT
          (SELECT status FROM reports WHERE id=$1) AS status,
          (SELECT COUNT(*)::text FROM activity WHERE type='deny' AND report_id=$1) AS activity_count`,
        [report.id],
      );
      expect(rolledBack.rows[0]).toEqual({ status: "pending", activity_count: "0" });
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS fail_deny_report_activity ON activity");
      await pool.query("DROP FUNCTION IF EXISTS fail_deny_report_activity()");
    }

    expect((await resolve(accusedToken)).status).toBe(200);
    expect((await resolve(accusedToken)).status).toBe(404);
    const history = await buildApp().request("/api/reports/history", {
      headers: { Authorization: `Bearer ${accusedToken}` },
    });
    expect(history.status).toBe(200);
    expect(ReportSchema.array().parse(await history.json())).toEqual([
      expect.objectContaining({ id: report.id, status: "denied" }),
    ]);
  });

  it("denies a report", async () => {
    const accuser = await store.createUser({ name: "Karen" });
    const accused = await store.createUser({ name: "Leo" });
    const jar = await store.createJar({ userId: accuser.id, name: "Deny Jar", rule: "" });
    const detail = await store.getJarDetail(jar.id, accuser.id);
    if (!detail) throw new Error("created deny jar detail missing");
    await store.joinJarByCode(accused.id, requireInviteCode(detail));

    const report = await store.createReport({
      jarId: jar.id,
      accuserId: accuser.id,
      accusedId: accused.id,
      note: null,
      anonymous: true,
      amountCents: 500,
      evidence: [],
    });
    const denied = await store.resolveReport(report.id, accused.id, "deny");
    expect(denied?.status).toBe("denied");
  });

  it("keeps owned and denied reports as anonymous-safe member history while isolating outsiders", async () => {
    const accuser = await store.createUser({ name: "History Reporter" });
    const accused = await store.createUser({ name: "History Accused" });
    const member = await store.createUser({ name: "History Member" });
    const outsider = await store.createUser({ name: "History Outsider" });
    const jar = await store.createJar({ userId: accuser.id, name: "History Jar" });
    const detail = await store.getJarDetail(jar.id, accuser.id);
    if (!detail) throw new Error("created history jar detail missing");
    const inviteCode = requireInviteCode(detail);
    await store.joinJarByCode(accused.id, inviteCode);
    await store.joinJarByCode(member.id, inviteCode);

    const owned = await store.createReport({
      jarId: jar.id,
      accuserId: accuser.id,
      accusedId: accused.id,
      note: "anonymous evidence survives",
      anonymous: true,
      amountCents: 500,
      evidence: [
        sanitizeEvidenceImage({
          mimeType: "image/png",
          dataUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        }),
      ],
    });
    expect(await store.reportForUser(owned.id, member.id)).toMatchObject({ status: "pending" });
    expect(await store.reportForUser(owned.id, outsider.id)).toBeNull();
    expect(await store.resolveReport(owned.id, member.id, "deny")).toBeNull();
    expect(await store.resolveReport(owned.id, accused.id, "own")).toMatchObject({
      status: "owned",
    });

    const denied = await store.createReport({
      jarId: jar.id,
      accuserId: accuser.id,
      accusedId: accused.id,
      note: "denied but retained",
      anonymous: false,
      amountCents: 500,
      evidence: [],
    });
    expect(await store.resolveReport(denied.id, accused.id, "deny")).toMatchObject({
      status: "denied",
    });

    const accusedHistory = await store.reportHistoryForUser(accused.id);
    const memberHistory = await store.reportHistoryForUser(member.id);
    expect(accusedHistory.map((report) => report.status).sort()).toEqual(["denied", "owned"]);
    expect(memberHistory.map((report) => report.status).sort()).toEqual(["denied", "owned"]);
    expect(await store.reportHistoryForUser(outsider.id)).toEqual([]);

    const protectedDetail = await store.reportForUser(owned.id, member.id);
    expect(protectedDetail).toMatchObject({
      id: owned.id,
      status: "owned",
      anonymous: true,
      accuser: null,
      evidence: [expect.objectContaining({ mimeType: "image/png" })],
    });
    expect(JSON.stringify(protectedDetail)).not.toContain(accuser.id);
    expect(await store.reportForUser(owned.id, outsider.id)).toBeNull();

    const memberToken = await store.createSession(member.id);
    const outsiderToken = await store.createSession(outsider.id);
    const memberListResponse = await buildApp().request("/api/reports/history", {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(memberListResponse.status).toBe(200);
    expect(ReportSchema.array().parse(await memberListResponse.json())).toHaveLength(2);

    const memberDetailResponse = await buildApp().request(`/api/reports/${owned.id}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(memberDetailResponse.status).toBe(200);
    const memberDetailJson = await memberDetailResponse.text();
    expect(memberDetailJson).not.toContain(accuser.id);
    expect(memberDetailJson).toContain("anonymous evidence survives");

    const outsiderDetailResponse = await buildApp().request(`/api/reports/${owned.id}`, {
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    expect(outsiderDetailResponse.status).toBe(404);
    const outsiderListResponse = await buildApp().request("/api/reports/history", {
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    expect(await outsiderListResponse.json()).toEqual([]);

    const activity = await store.activityForUser(member.id);
    expect(activity.some((entry) => entry.reportId === owned.id)).toBe(true);
    expect(activity.some((entry) => entry.reportId === denied.id)).toBe(true);

    await store.closeJar(jar.id, accuser.id);
    expect((await store.reportHistoryForUser(member.id)).map((report) => report.id)).toEqual(
      expect.arrayContaining([denied.id, owned.id]),
    );
    const closedDetailResponse = await buildApp().request(`/api/reports/${owned.id}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(closedDetailResponse.status).toBe(200);
    expect(ReportSchema.parse(await closedDetailResponse.json())).toMatchObject({
      id: owned.id,
      status: "owned",
      accuser: null,
      evidence: [expect.objectContaining({ mimeType: "image/png" })],
    });
  });

  it("redacts an anonymous reporter from activity while retaining the protected reporter id", async () => {
    const accuser = await store.createUser({ name: "Private Reporter" });
    const accused = await store.createUser({ name: "Reported Member" });
    const jar = await store.createJar({ userId: accuser.id, name: "Anonymous Report Jar" });
    const detail = await store.getJarDetail(jar.id, accuser.id);
    if (!detail) throw new Error("created anonymous report jar detail missing");
    await store.joinJarByCode(accused.id, requireInviteCode(detail));

    const report = await store.createReport({
      jarId: jar.id,
      accuserId: accuser.id,
      accusedId: accused.id,
      note: "private report",
      anonymous: true,
      amountCents: 500,
      evidence: [],
    });

    const activity = await store.activityForUser(accused.id);
    const reportActivity = activity.find((entry) => entry.type === "report");
    expect(reportActivity?.by).toBeNull();
    expect(JSON.stringify(reportActivity)).not.toContain(accuser.id);

    const accusedToken = await store.createSession(accused.id);
    const activityResponse = await buildApp().request("/api/activity", {
      headers: { Authorization: `Bearer ${accusedToken}` },
    });
    expect(activityResponse.status).toBe(200);
    const activityJson = await activityResponse.text();
    expect(activityJson).not.toContain(accuser.id);

    const persisted = await pool.query<{ accuser_id: string }>(
      "SELECT accuser_id FROM reports WHERE id=$1",
      [report.id],
    );
    expect(persisted.rows[0]?.accuser_id).toBe(accuser.id);
  });
});

describe.skipIf(!HAS_DB)("authorization matrix", () => {
  it("enforces capability and membership boundaries without existence leaks", async () => {
    const owner = await store.createUser({ name: "Matrix Owner" });
    const member = await store.createUser({ name: "Matrix Member" });
    const accused = await store.createUser({ name: "Matrix Accused" });
    const former = await store.createUser({ name: "Matrix Former" });
    const outsider = await store.createUser({ name: "Matrix Outsider" });
    const actorNames = ["owner", "member", "accused", "former", "outsider"] as const;
    type Actor = (typeof actorNames)[number];
    const tokens = {
      owner: await store.createSession(owner.id),
      member: await store.createSession(member.id),
      accused: await store.createSession(accused.id),
      former: await store.createSession(former.id),
      outsider: await store.createSession(outsider.id),
    } as const;
    const request = (actor: Actor, path: string, method = "GET", body?: unknown) => {
      const previewCode = /^\/jars\/code\/(.+)$/.exec(path)?.[1];
      const requestBody = previewCode === undefined ? body : { code: previewCode };
      return buildApp().request(previewCode === undefined ? `/api${path}` : "/api/jars/preview", {
        method: previewCode === undefined ? method : "POST",
        headers: {
          Authorization: `Bearer ${tokens[actor]}`,
          ...(requestBody === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
      });
    };
    const expectStatuses = async (
      path: string,
      expected: Readonly<Record<Actor, number>>,
      method = "GET",
      body?: unknown,
    ) => {
      for (const actor of actorNames) {
        expect(
          (await request(actor, path, method, body)).status,
          `${actor} ${method} ${path}`,
        ).toBe(expected[actor]);
      }
    };

    const jar = await store.createJar({ userId: owner.id, name: "Matrix Jar" });
    const detail = await store.getJarDetail(jar.id, owner.id);
    const code = requireInviteCode(detail);
    await store.joinJarByCode(member.id, code);
    await store.joinJarByCode(accused.id, code);
    await store.joinJarByCode(former.id, code);
    const formerPendingReport = await store.createReport({
      jarId: jar.id,
      accuserId: owner.id,
      accusedId: former.id,
      note: "Must disappear after membership ends",
      anonymous: false,
      amountCents: 500,
      evidence: [],
    });
    await store.leaveJar(jar.id, former.id);

    const active200 = { owner: 200, member: 200, accused: 200, former: 404, outsider: 404 };
    await expectStatuses(`/jars/${jar.id}`, active200);
    const hidden = await request("outsider", `/jars/${jar.id}`);
    const absent = await request("outsider", "/jars/jar_doesnotexist");
    expect(await hidden.json()).toEqual(await absent.json());

    await expectStatuses(`/jars/code/${code}`, {
      owner: 200,
      member: 200,
      accused: 200,
      former: 200,
      outsider: 200,
    });
    await expectStatuses(`/jars/${jar.id}/slips`, active200, "POST", { amountCents: 500 });
    await expectStatuses(`/jars/${jar.id}/share-streak`, active200, "POST", { value: true });

    const reportResponse = await request("member", `/jars/${jar.id}/reports`, "POST", {
      accusedId: accused.id,
      note: "Matrix report",
    });
    expect(reportResponse.status).toBe(200);
    const report = ReportSchema.parse(await reportResponse.json());
    expect(
      (
        await request("owner", `/jars/${jar.id}/reports`, "POST", {
          accusedId: accused.id,
          note: "Owner report",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("accused", `/jars/${jar.id}/reports`, "POST", {
          accusedId: member.id,
          note: "Accused can also report another member",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("accused", `/jars/${jar.id}/reports`, "POST", {
          accusedId: accused.id,
          note: "self",
        })
      ).status,
    ).toBe(400);
    for (const actor of ["former", "outsider"] as const) {
      expect(
        (
          await request(actor, `/jars/${jar.id}/reports`, "POST", {
            accusedId: accused.id,
            note: "blocked",
          })
        ).status,
      ).toBe(404);
    }
    await expectStatuses(`/reports/${report.id}`, active200);
    const hiddenReport = await request("outsider", `/reports/${report.id}`);
    const absentReport = await request("outsider", "/reports/rpt_doesnotexist");
    expect(await hiddenReport.json()).toEqual(await absentReport.json());

    for (const actor of actorNames) {
      const pending = ReportSchema.array().parse(
        await (await request(actor, "/reports/pending")).json(),
      );
      expect(pending.some((entry) => entry.id === report.id)).toBe(actor === "accused");
      expect(pending.some((entry) => entry.id === formerPendingReport.id)).toBe(false);
    }
    await expectStatuses(
      `/reports/${report.id}/resolve`,
      {
        owner: 404,
        member: 404,
        accused: 200,
        former: 404,
        outsider: 404,
      },
      "POST",
      { action: "deny" },
    );
    for (const actor of actorNames) {
      const history = ReportSchema.array().parse(
        await (await request(actor, "/reports/history")).json(),
      );
      expect(history.some((entry) => entry.id === report.id)).toBe(
        actor === "owner" || actor === "member" || actor === "accused",
      );
    }

    const leaveJar = await store.createJar({ userId: owner.id, name: "Leave Matrix" });
    const leaveDetail = await store.getJarDetail(leaveJar.id, owner.id);
    const leaveCode = requireInviteCode(leaveDetail);
    await store.joinJarByCode(member.id, leaveCode);
    await store.joinJarByCode(accused.id, leaveCode);
    await store.joinJarByCode(former.id, leaveCode);
    await store.leaveJar(leaveJar.id, former.id);
    await expectStatuses(
      `/jars/${leaveJar.id}/leave`,
      {
        owner: 409,
        member: 200,
        accused: 200,
        former: 404,
        outsider: 404,
      },
      "POST",
      { confirmed: true },
    );

    const closeJar = await store.createJar({ userId: owner.id, name: "Close Matrix" });
    const closeDetail = await store.getJarDetail(closeJar.id, owner.id);
    const closeCode = requireInviteCode(closeDetail);
    await store.joinJarByCode(member.id, closeCode);
    await store.joinJarByCode(accused.id, closeCode);
    await store.joinJarByCode(former.id, closeCode);
    await store.leaveJar(closeJar.id, former.id);
    for (const actor of ["member", "accused"] as const) {
      expect(
        (await request(actor, `/jars/${closeJar.id}/close`, "POST", { confirmed: true })).status,
      ).toBe(403);
    }
    for (const actor of ["former", "outsider"] as const) {
      expect(
        (await request(actor, `/jars/${closeJar.id}/close`, "POST", { confirmed: true })).status,
      ).toBe(404);
    }
    expect(
      (await request("owner", `/jars/${closeJar.id}/close`, "POST", { confirmed: true })).status,
    ).toBe(200);
    await expectStatuses(`/jars/code/${closeCode}`, {
      owner: 404,
      member: 404,
      accused: 404,
      former: 404,
      outsider: 404,
    });

    const joinJar = await store.createJar({ userId: owner.id, name: "Join Matrix" });
    const joinDetail = await store.getJarDetail(joinJar.id, owner.id);
    const joinCode = requireInviteCode(joinDetail);
    await store.joinJarByCode(former.id, joinCode);
    await store.leaveJar(joinJar.id, former.id);
    await expectStatuses(
      "/jars/join",
      {
        owner: 200,
        member: 200,
        accused: 200,
        former: 200,
        outsider: 200,
      },
      "POST",
      { code: joinCode },
    );
  });
});

describe.skipIf(!HAS_DB)("transactional domain events", () => {
  it("emits complete versioned events for existing jar, membership, slip, milestone and report mutations", async () => {
    const owner = await store.createUser({ name: "Event Owner" });
    const member = await store.createUser({ name: "Event Member" });
    const jar = await store.createJar({ userId: owner.id, name: "Event Jar" });
    const detail = await store.getJarDetail(jar.id, owner.id);
    await store.joinJarByCode(member.id, requireInviteCode(detail));
    await store.logSlip({ jarId: jar.id, userId: owner.id, amountCents: 5000 });
    const report = await store.createReport({
      jarId: jar.id,
      accuserId: owner.id,
      accusedId: member.id,
      note: "event test",
      anonymous: false,
      amountCents: 500,
      evidence: [],
    });
    await store.resolveReport(report.id, member.id, "own");
    await store.rotateInvite(jar.id, owner.id);
    await store.leaveJar(jar.id, member.id);
    await store.closeJar(jar.id, owner.id);

    const events = await new PostgresOutbox(pool).claimPage({
      owner: "event-test",
      limit: 50,
      now: Date.now() + 1,
      leaseUntil: Date.now() + 10_000,
    });
    const types = events.map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "jar.created",
        "invite.issued",
        "membership.joined",
        "slip.logged",
        "jar.milestone_crossed",
        "report.created",
        "report.owned",
        "invite.superseded",
        "membership.left",
        "jar.closed",
      ]),
    );
    expect(types.filter((type) => type === "slip.logged")).toHaveLength(2);
    expect(types.filter((type) => type === "invite.issued")).toHaveLength(2);
    expect(types.filter((type) => type === "invite.superseded")).toHaveLength(2);
    expect(events).toHaveLength(13);
  });
});

describe.skipIf(!HAS_DB)("activity", () => {
  it("activityForUser returns jar activity", async () => {
    const u = await store.createUser({ name: "Mia" });
    const jar = await store.createJar({ userId: u.id, name: "Activity Jar", rule: "" });
    await store.logSlip({ jarId: jar.id, userId: u.id, amountCents: 500, note: null });
    const acts = await store.activityForUser(u.id);
    expect(acts.length).toBeGreaterThan(0);
    const types = acts.map((a) => a.type);
    expect(types).toContain("slip");
  });

  it("does not expose a private ex label in shared jar or activity JSON", async () => {
    const owner = await store.createUser({ name: "Slip Owner" });
    const member = await store.createUser({ name: "Activity Member" });
    const jar = await store.createJar({ userId: owner.id, name: "Private Label Jar" });
    const detail = await store.getJarDetail(jar.id, owner.id);
    if (!detail) throw new Error("created private label jar detail missing");
    await store.joinJarByCode(member.id, requireInviteCode(detail));
    await store.logSlip({
      jarId: jar.id,
      userId: owner.id,
      amountCents: 500,
      exLabel: "Secret Ex",
    });

    const memberToken = await store.createSession(member.id);
    for (const path of ["/api/activity", `/api/jars/${jar.id}`]) {
      const response = await buildApp().request(path, {
        headers: { Authorization: `Bearer ${memberToken}` },
      });
      expect(response.status).toBe(200);
      const rawJson = await response.text();
      expect(rawJson).not.toContain('"exLabel"');
      expect(rawJson).not.toContain("Secret Ex");
    }
  });

  it("keeps profile ex labels out of every pending and resolved shared API DTO", async () => {
    const owner = await store.createUser({ name: "Private Owner", exes: ["Owner Secret"] });
    const member = await store.createUser({ name: "Private Member", exes: ["Member Secret"] });
    const jar = await store.createJar({ userId: owner.id, name: "Private DTO Jar" });
    const ownerDetail = await store.getJarDetail(jar.id, owner.id);
    const inviteCode = requireInviteCode(ownerDetail);
    await store.joinJarByCode(member.id, inviteCode);
    await store.logSlip({
      jarId: jar.id,
      userId: owner.id,
      amountCents: 500,
      exLabel: "Owner Slip Secret",
    });
    const ownedReport = await store.createReport({
      jarId: jar.id,
      accuserId: owner.id,
      accusedId: member.id,
      note: "Owned shared report",
      anonymous: false,
      amountCents: 500,
      evidence: [],
    });
    const deniedReport = await store.createReport({
      jarId: jar.id,
      accuserId: member.id,
      accusedId: owner.id,
      note: "Denied shared report",
      anonymous: false,
      amountCents: 500,
      evidence: [],
    });
    const tokens = {
      owner: await store.createSession(owner.id),
      member: await store.createSession(member.id),
    } as const;
    const request = (token: string, path: string, method = "GET", body?: unknown) => {
      const previewCode = /^\/api\/jars\/code\/(.+)$/.exec(path)?.[1];
      const requestBody = previewCode === undefined ? body : { code: previewCode };
      return buildApp().request(previewCode === undefined ? path : "/api/jars/preview", {
        method: previewCode === undefined ? method : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(requestBody === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
      });
    };
    const expectPrivateLabelsAbsent = async (response: Response, context: string) => {
      expect(response.status, context).toBe(200);
      const raw = await response.text();
      expect(raw, context).not.toContain('"exes"');
      expect(raw, context).not.toContain('"exLabel"');
      for (const privateValue of ["Owner Secret", "Member Secret", "Owner Slip Secret"]) {
        expect(raw, context).not.toContain(privateValue);
      }
    };

    for (const [viewer, token] of Object.entries(tokens)) {
      const me = await request(token, "/api/me");
      expect(me.status, `${viewer} me`).toBe(200);
      expect(await me.json()).toMatchObject({
        exes: [viewer === "owner" ? "Owner Secret" : "Member Secret"],
      });
      await expectPrivateLabelsAbsent(
        await request(token, "/api/reports/pending"),
        `${viewer} pending reports`,
      );
    }

    await expectPrivateLabelsAbsent(
      await request(tokens.member, `/api/reports/${ownedReport.id}/resolve`, "POST", {
        action: "own",
      }),
      "member own response",
    );
    await expectPrivateLabelsAbsent(
      await request(tokens.owner, `/api/reports/${deniedReport.id}/resolve`, "POST", {
        action: "deny",
      }),
      "owner deny response",
    );

    const sharedPaths = [
      "/api/jars",
      `/api/jars/${jar.id}`,
      `/api/jars/code/${inviteCode}`,
      "/api/activity",
      "/api/reports/pending",
      "/api/reports/history",
      `/api/reports/${ownedReport.id}`,
      `/api/reports/${deniedReport.id}`,
    ];
    for (const [viewer, token] of Object.entries(tokens)) {
      for (const path of sharedPaths) {
        await expectPrivateLabelsAbsent(await request(token, path), `${viewer} ${path}`);
      }
    }
  });
});
