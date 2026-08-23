import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotificationIdSchema, UserIdSchema } from "../../../../contracts";
import { pool } from "../db/index";
import { runMigrations } from "../db/migrate";
import { buildApp } from "../server";
import * as store from "../store";

const HAS_DB = !!process.env.DATABASE_URL;

async function sessionHeaders(userId: string) {
  const token = await store.createSession(UserIdSchema.parse(userId));
  return { Authorization: `Bearer ${token}` };
}

function preview(app: ReturnType<typeof buildApp>, code: string, headers: Record<string, string>) {
  return app.request("/api/jars/preview", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

beforeAll(async () => {
  if (HAS_DB) await runMigrations();
});

beforeEach(async () => {
  if (!HAS_DB) return;
  await pool.query(`
    TRUNCATE domain_event, notification_delivery, user_notification, user_block,
             report_evidence, reports, activity, slips, membership_tenures,
             memberships, sessions, user_exes, jars, users RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  if (HAS_DB) await pool.end();
});

describe.skipIf(!HAS_DB).sequential("block API persistence and enforcement", () => {
  it("is idempotent, hides unknown users, and bilaterally fences invite and report interaction", async () => {
    const alice = await store.createUser({ name: "Alice" });
    const bob = await store.createUser({ name: "Bob" });
    const aliceHeaders = await sessionHeaders(alice.id);
    const bobHeaders = await sessionHeaders(bob.id);
    const app = buildApp();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.request(`/api/me/blocks/${bob.id}`, {
        method: "PUT",
        headers: aliceHeaders,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
    expect(
      (await pool.query("SELECT 1 FROM user_block WHERE blocker_user_id=$1", [alice.id])).rowCount,
    ).toBe(1);
    const listed = await app.request("/api/me/blocks", { headers: aliceHeaders });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([expect.objectContaining({ id: bob.id, name: "Bob" })]);

    const unknown = await app.request("/api/me/blocks/usr_doesnotexist", {
      method: "PUT",
      headers: aliceHeaders,
    });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ ok: true });

    const aliceJar = await store.createJar({ userId: alice.id, name: "Alice Jar" });
    const aliceDetail = await store.getJarDetail(aliceJar.id, alice.id);
    if (!aliceDetail?.inviteCode) throw new Error("Alice jar invite missing");
    expect((await preview(app, aliceDetail.inviteCode, bobHeaders)).status).toBe(404);
    expect(
      (
        await app.request("/api/jars/join", {
          method: "POST",
          headers: { ...bobHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ code: aliceDetail.inviteCode }),
        })
      ).status,
    ).toBe(404);

    const bobJar = await store.createJar({ userId: bob.id, name: "Bob Jar" });
    const bobDetail = await store.getJarDetail(bobJar.id, bob.id);
    if (!bobDetail?.inviteCode) throw new Error("Bob jar invite missing");
    expect((await preview(app, bobDetail.inviteCode, aliceHeaders)).status).toBe(404);

    await app.request(`/api/me/blocks/${bob.id}`, { method: "DELETE", headers: aliceHeaders });
    expect(await (await app.request("/api/me/blocks", { headers: aliceHeaders })).json()).toEqual(
      [],
    );
    expect((await preview(app, aliceDetail.inviteCode, bobHeaders)).status).toBe(200);
    expect(
      (
        await app.request("/api/jars/join", {
          method: "POST",
          headers: { ...bobHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ code: aliceDetail.inviteCode }),
        })
      ).status,
    ).toBe(200);

    await app.request(`/api/me/blocks/${bob.id}`, { method: "PUT", headers: aliceHeaders });
    const aliceJarView = await app.request(`/api/jars/${aliceJar.id}`, { headers: aliceHeaders });
    const bobJarView = await app.request(`/api/jars/${aliceJar.id}`, { headers: bobHeaders });
    expect(aliceJarView.status).toBe(200);
    expect(bobJarView.status).toBe(200);
    expect(await aliceJarView.text()).not.toContain(bob.id);
    expect(await bobJarView.text()).not.toContain(alice.id);
    expect(
      await (await app.request("/api/activity", { headers: aliceHeaders })).text(),
    ).not.toContain(bob.id);
    expect(
      await (await app.request("/api/activity", { headers: bobHeaders })).text(),
    ).not.toContain(alice.id);
    const eventsBefore = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM domain_event WHERE event_type='report.created'",
    );
    const blockedReport = await app.request(`/api/jars/${aliceJar.id}/reports`, {
      method: "POST",
      headers: { ...bobHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ accusedId: alice.id, note: "must be hidden" }),
    });
    expect(blockedReport.status).toBe(404);
    expect(await blockedReport.json()).toEqual({ error: "not_found" });
    expect(
      (
        await pool.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM domain_event WHERE event_type='report.created'",
        )
      ).rows[0]?.count,
    ).toBe(eventsBefore.rows[0]?.count);
  });

  it("fences shared-state mutations while preserving leave and owner close as protective exits", async () => {
    const alice = await store.createUser({ name: "Safety Alice" });
    const bob = await store.createUser({ name: "Safety Bob" });
    const mutationJar = await store.createJar({ userId: alice.id, name: "Mutation Jar" });
    const mutationDetail = await store.getJarDetail(mutationJar.id, alice.id);
    if (!mutationDetail?.inviteCode) throw new Error("mutation jar invite missing");
    await store.joinJarByCode(bob.id, mutationDetail.inviteCode);
    const leaveJar = await store.createJar({ userId: alice.id, name: "Leave Jar" });
    const leaveDetail = await store.getJarDetail(leaveJar.id, alice.id);
    if (!leaveDetail?.inviteCode) throw new Error("leave jar invite missing");
    await store.joinJarByCode(bob.id, leaveDetail.inviteCode);

    const aliceHeaders = await sessionHeaders(alice.id);
    const bobHeaders = await sessionHeaders(bob.id);
    const app = buildApp();
    await store.blockUser(alice.id, bob.id);

    const blockedRequests = [
      app.request(`/api/jars/${mutationJar.id}/share-streak`, {
        method: "POST",
        headers: { ...bobHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ value: true }),
      }),
      app.request(`/api/jars/${mutationJar.id}/slips`, {
        method: "POST",
        headers: { ...bobHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ amountCents: 500 }),
      }),
      app.request(`/api/jars/${mutationJar.id}/invite/rotate`, {
        method: "POST",
        headers: { ...aliceHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      }),
    ];
    for (const responsePromise of blockedRequests) {
      const response = await responsePromise;
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
    expect(
      (await pool.query("SELECT 1 FROM slips WHERE jar_id=$1", [mutationJar.id])).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query<{ share_streak: number }>(
          "SELECT share_streak FROM memberships WHERE jar_id=$1 AND user_id=$2",
          [mutationJar.id, bob.id],
        )
      ).rows[0]?.share_streak,
    ).toBe(0);
    expect((await store.getJarDetail(mutationJar.id, alice.id))?.inviteCode).toBe(
      mutationDetail.inviteCode,
    );

    const leave = await app.request(`/api/jars/${leaveJar.id}/leave`, {
      method: "POST",
      headers: { ...bobHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    expect(leave.status).toBe(200);
    expect(await leave.json()).toEqual({ ok: true });

    const close = await app.request(`/api/jars/${mutationJar.id}/close`, {
      method: "POST",
      headers: { ...aliceHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    expect(close.status).toBe(200);
    expect((await store.getJarDetail(mutationJar.id, alice.id))?.closedAt).toEqual(
      expect.any(Number),
    );
  });

  it("serializes join and report writes behind an uncommitted block", async () => {
    const owner = await store.createUser({ name: "Race Owner" });
    const member = await store.createUser({ name: "Race Member" });
    const joiner = await store.createUser({ name: "Race Joiner" });
    const jar = await store.createJar({ userId: owner.id, name: "Race Jar" });
    const detail = await store.getJarDetail(jar.id, owner.id);
    if (!detail?.inviteCode) throw new Error("race jar invite missing");
    await store.joinJarByCode(member.id, detail.inviteCode);

    const joinBlock = await pool.connect();
    try {
      await joinBlock.query("BEGIN");
      await joinBlock.query(
        "SELECT id FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE",
        [[owner.id, joiner.id]],
      );
      await joinBlock.query(
        "INSERT INTO user_block (blocker_user_id,blocked_user_id,created_at) VALUES ($1,$2,$3)",
        [owner.id, joiner.id, Date.now()],
      );
      const join = store.joinJarByCode(joiner.id, detail.inviteCode);
      expect(
        await Promise.race([
          join.then(
            () => "settled",
            () => "settled",
          ),
          new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
        ]),
      ).toBe("pending");
      await joinBlock.query("COMMIT");
      await expect(join).resolves.toBeNull();
    } finally {
      await joinBlock.query("ROLLBACK").catch(() => undefined);
      joinBlock.release();
    }

    const reportBlock = await pool.connect();
    try {
      await reportBlock.query("BEGIN");
      await reportBlock.query(
        "SELECT id FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE",
        [[owner.id, member.id]],
      );
      await reportBlock.query(
        "INSERT INTO user_block (blocker_user_id,blocked_user_id,created_at) VALUES ($1,$2,$3)",
        [owner.id, member.id, Date.now()],
      );
      const report = store.createReport({
        jarId: jar.id,
        accuserId: member.id,
        accusedId: owner.id,
        note: "must not race through",
        anonymous: false,
        amountCents: 500,
        evidence: [],
      });
      expect(
        await Promise.race([
          report.then(
            () => "settled",
            () => "settled",
          ),
          new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
        ]),
      ).toBe("pending");
      await reportBlock.query("COMMIT");
      await expect(report).rejects.toBeInstanceOf(store.BlockedInteractionError);
      expect(
        (await pool.query("SELECT 1 FROM reports WHERE note='must not race through'")).rowCount,
      ).toBe(0);
    } finally {
      await reportBlock.query("ROLLBACK").catch(() => undefined);
      reportBlock.release();
    }
  });

  it("serializes report denial behind an uncommitted block without changing the report", async () => {
    const accuser = await store.createUser({ name: "Resolution Race Accuser" });
    const accused = await store.createUser({ name: "Resolution Race Accused" });
    const jar = await store.createJar({ userId: accuser.id, name: "Resolution Race Jar" });
    const detail = await store.getJarDetail(jar.id, accuser.id);
    if (!detail?.inviteCode) throw new Error("resolution race jar invite missing");
    await store.joinJarByCode(accused.id, detail.inviteCode);
    const report = await store.createReport({
      jarId: jar.id,
      accuserId: accuser.id,
      accusedId: accused.id,
      note: "must remain pending after block wins",
      anonymous: false,
      amountCents: 500,
      evidence: [],
    });
    const activityBefore = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM activity WHERE report_id=$1",
      [report.id],
    );
    const eventsBefore = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM domain_event WHERE aggregate_id=$1",
      [report.id],
    );

    const block = await pool.connect();
    try {
      await block.query("BEGIN");
      await block.query("SELECT id FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE", [
        [accuser.id, accused.id],
      ]);
      await block.query(
        "INSERT INTO user_block (blocker_user_id,blocked_user_id,created_at) VALUES ($1,$2,$3)",
        [accuser.id, accused.id, Date.now()],
      );

      const resolution = store.resolveReport(report.id, accused.id, "deny");
      expect(
        await Promise.race([
          resolution.then(
            () => "settled",
            () => "settled",
          ),
          new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
        ]),
      ).toBe("pending");

      await block.query("COMMIT");
      await expect(resolution).resolves.toBeNull();
    } finally {
      await block.query("ROLLBACK").catch(() => undefined);
      block.release();
    }

    await expect(
      pool.query<{ status: string; resolved_at: string | null }>(
        "SELECT status,resolved_at FROM reports WHERE id=$1",
        [report.id],
      ),
    ).resolves.toMatchObject({ rows: [{ status: "pending", resolved_at: null }] });
    await expect(
      pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM activity WHERE report_id=$1",
        [report.id],
      ),
    ).resolves.toMatchObject({ rows: activityBefore.rows });
    await expect(
      pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM domain_event WHERE aggregate_id=$1",
        [report.id],
      ),
    ).resolves.toMatchObject({ rows: eventsBefore.rows });
  });

  it("cancels pending pair notifications and suppresses deliveries when a block is created", async () => {
    const alice = await store.createUser({ name: "Notification Alice" });
    const bob = await store.createUser({ name: "Notification Bob" });
    const jar = await store.createJar({ userId: alice.id, name: "Notification Jar" });
    const detail = await store.getJarDetail(jar.id, alice.id);
    if (!detail?.inviteCode) throw new Error("notification jar invite missing");
    await store.joinJarByCode(bob.id, detail.inviteCode);
    const report = await store.createReport({
      jarId: jar.id,
      accuserId: alice.id,
      accusedId: bob.id,
      note: "pending pair report",
      anonymous: false,
      amountCents: 500,
      evidence: [],
    });
    const notificationId = NotificationIdSchema.parse("ntf_99999999999999999999999999999999");
    await pool.query(
      `INSERT INTO user_notification
         (id,recipient_user_id,category,dedupe_key,target_type,target_id,message_key,created_at)
       VALUES ($1,$2,'report','block-test','report',$3,'report.pending',$4)`,
      [notificationId, bob.id, report.id, Date.now()],
    );
    await pool.query(
      `INSERT INTO push_device
         (installation_id,user_id,platform,environment,token_ciphertext,token_nonce,token_key_id,
          token_sha256,app_version,app_build,active,last_registered_at)
       VALUES ('dev_blocktest',$1,'ios','sandbox','cipher','nonce','key','hash','1.0','1',TRUE,$2)`,
      [bob.id, Date.now()],
    );
    await pool.query(
      `INSERT INTO notification_delivery
         (id,notification_id,installation_id,status,created_at,updated_at)
       VALUES ('ndl_blocktest',$1,'dev_blocktest','pending',$2,$2)`,
      [notificationId, Date.now()],
    );

    const headers = await sessionHeaders(alice.id);
    expect(
      (await buildApp().request(`/api/me/blocks/${bob.id}`, { method: "PUT", headers })).status,
    ).toBe(200);

    expect(
      (
        await pool.query<{ cancelled_at: string | null }>(
          "SELECT cancelled_at FROM user_notification WHERE id=$1",
          [notificationId],
        )
      ).rows[0]?.cancelled_at,
    ).not.toBeNull();
    expect(
      (
        await pool.query<{ status: string }>(
          "SELECT status FROM notification_delivery WHERE notification_id=$1",
          [notificationId],
        )
      ).rows[0]?.status,
    ).toBe("suppressed");

    const delayedNotification = await pool.query(
      `INSERT INTO user_notification
         (id,recipient_user_id,category,dedupe_key,target_type,target_id,message_key,created_at)
       VALUES ('ntf_88888888888888888888888888888888',$1,'report','block-delayed','report',$2,
               'report.pending',$3)
       RETURNING id`,
      [bob.id, report.id, Date.now()],
    );
    expect(delayedNotification.rowCount).toBe(0);
  });
});
