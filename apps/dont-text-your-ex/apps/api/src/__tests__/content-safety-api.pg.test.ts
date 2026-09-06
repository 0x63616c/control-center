import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UserIdSchema } from "../../../../contracts";
import { pool } from "../db/index";
import { runMigrations } from "../db/migrate";
import { buildApp } from "../server";
import * as store from "../store";

const HAS_DB = !!process.env.DATABASE_URL;

beforeAll(async () => {
  if (HAS_DB) await runMigrations();
});

beforeEach(async () => {
  if (!HAS_DB) return;
  await pool.query(`
    TRUNCATE abuse_report_audit_event, abuse_report, domain_event, notification_delivery,
             user_notification, user_block, report_evidence, reports, activity, slips,
             membership_tenures, memberships, sessions, user_exes, jars, users
    RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  if (HAS_DB) await pool.end();
});

async function fixture() {
  const owner = await store.createUser({ name: "Safe Owner" });
  const member = await store.createUser({ name: "Safe Member" });
  const ownerToken = await store.createSession(UserIdSchema.parse(owner.id));
  const memberToken = await store.createSession(UserIdSchema.parse(member.id));
  const jar = await store.createJar({ userId: owner.id, name: "Support Jar" });
  const detail = await store.getJarDetail(jar.id, owner.id);
  if (!detail?.inviteCode) throw new Error("fixture invite missing");
  await store.joinJarByCode(member.id, detail.inviteCode);
  return {
    owner,
    member,
    jar,
    ownerHeaders: {
      Authorization: `Bearer ${ownerToken}`,
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.201",
    },
    memberHeaders: {
      Authorization: `Bearer ${memberToken}`,
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.202",
    },
  };
}

async function expectFiltered(response: Response) {
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body).toMatchObject({ error: "content_not_allowed" });
  expect(JSON.stringify(body)).not.toMatch(/nigger|kill yourself|rape you/i);
}

describe.skipIf(!HAS_DB).sequential("server-side user-content safety boundaries", () => {
  it("rejects objectionable profile, ex-label, jar, and rule writes before persistence", async () => {
    const { ownerHeaders } = await fixture();
    const app = buildApp();

    await expectFiltered(
      await app.request("/api/me", {
        method: "PATCH",
        headers: ownerHeaders,
        body: JSON.stringify({ name: "n.i.g.g.3.r" }),
      }),
    );
    const emojiResponse = await buildApp().request("/api/me", {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ emoji: "nigger" }),
    });
    expect(emojiResponse.status).toBe(400);
    expect(JSON.stringify(await emojiResponse.json())).not.toMatch(/nigger/i);
    await expectFiltered(
      await app.request("/api/me", {
        method: "PATCH",
        headers: ownerHeaders,
        body: JSON.stringify({ exes: ["Please kill yourself"] }),
      }),
    );
    await expectFiltered(
      await app.request("/api/jars", {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ name: "Support", rule: "I will rape you" }),
      }),
    );

    expect((await pool.query("SELECT 1 FROM users WHERE name='n.i.g.g.3.r'")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM users WHERE emoji='nigger'")).rowCount).toBe(0);
    expect(
      (await pool.query("SELECT 1 FROM user_exes WHERE label='Please kill yourself'")).rowCount,
    ).toBe(0);
    expect((await pool.query("SELECT 1 FROM jars WHERE rule='I will rape you'")).rowCount).toBe(0);
  });

  it("rejects objectionable slip, gameplay-report, and abuse-report text atomically", async () => {
    const { jar, member, owner, ownerHeaders, memberHeaders } = await fixture();
    const app = buildApp();

    await expectFiltered(
      await app.request(`/api/jars/${jar.id}/slips`, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ amountCents: 500, note: "Kill yourself" }),
      }),
    );
    await expectFiltered(
      await app.request(`/api/jars/${jar.id}/reports`, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ accusedId: member.id, note: "I will rape you" }),
      }),
    );
    await expectFiltered(
      await app.request("/api/moderation/reports", {
        method: "POST",
        headers: memberHeaders,
        body: JSON.stringify({ targetUserId: owner.id, narrative: "n i g g e r" }),
      }),
    );

    expect((await pool.query("SELECT 1 FROM slips")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM reports")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM abuse_report")).rowCount).toBe(0);
  });

  it("checks Apple display names before token verification and accepts ordinary supportive writes", async () => {
    const app = buildApp();
    await expectFiltered(
      await app.request("/api/auth/apple", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.203",
        },
        body: JSON.stringify({
          identityToken: "not-a-token",
          nonce: `nonce_${"a".repeat(48)}`,
          fullName: "You should kill yourself",
        }),
      }),
    );

    const { ownerHeaders } = await fixture();
    const created = await app.request("/api/jars", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        name: "Fresh Start",
        rule: "Support each other and talk to someone you trust.",
      }),
    });
    expect(created.status).toBe(200);
  });
});
