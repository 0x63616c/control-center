import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JarDetailSchema } from "../../../../contracts";
import { pool } from "../db/index";
import { runMigrations } from "../db/migrate";
import { buildApp } from "../server";
import * as store from "../store";

// DB-integration suite: requires a real Postgres (DATABASE_URL). The default unit
// gate has no DB, so these skip and the hooks no-op; the db layer still imports
// (buildDatabaseUrl returns undefined when unconfigured rather than throwing).
// Locally: DATABASE_URL=postgresql://postgres:test@localhost:5432/tye_test bun run test --project dont-text-your-ex-api
const HAS_DB = !!process.env.DATABASE_URL;

beforeAll(async () => {
  if (!HAS_DB) return;
  await runMigrations();
});

beforeEach(async () => {
  if (!HAS_DB) return;
  // Truncate all tables in reverse dep order
  await pool.query(`
    TRUNCATE report_evidence, reports, activity, slips, memberships,
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
    expect(u.exes).toEqual(["Bob"]);
  });

  it("creates session and resolves userId", async () => {
    const u = await store.createUser({ name: "Bob" });
    const token = await store.createSession(u.id);
    expect(token).toMatch(/^sess_/);
    const uid = await store.userIdForToken(token);
    expect(uid).toBe(u.id);
  });

  it("deletes session", async () => {
    const u = await store.createUser({ name: "Carol" });
    const token = await store.createSession(u.id);
    await store.deleteSession(token);
    const uid = await store.userIdForToken(token);
    expect(uid).toBeNull();
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
});

describe.skipIf(!HAS_DB)("jar lifecycle", () => {
  it("starts new owner and member streak sharing as private", async () => {
    const owner = await store.createUser({ name: "Private Owner" });
    const member = await store.createUser({ name: "Private Member" });
    const jar = await store.createJar({ userId: owner.id, name: "Opt-in Jar" });
    expect(jar.myShareStreak).toBe(false);

    const detail = await store.getJarDetail(jar.id, owner.id);
    if (!detail) throw new Error("created opt-in jar detail missing");
    await store.joinJarByCode(member.id, detail.inviteCode);

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
    const code = detail.inviteCode;

    const joiner = await store.createUser({ name: "Grace" });
    const result = await store.joinJarByCode(joiner.id, code);
    expect(result).not.toBeNull();
    expect(result?.jarId).toBe(jar.id);

    const joinedDetail = await store.getJarDetail(jar.id, owner.id);
    expect(joinedDetail?.members).toHaveLength(2);
  });

  it("hides a member's private streak from other members and rejects outsiders", async () => {
    const owner = await store.createUser({ name: "Streak Owner" });
    const member = await store.createUser({ name: "Jar Member" });
    const outsider = await store.createUser({ name: "Outsider" });
    const jar = await store.createJar({ userId: owner.id, name: "Private Streak Jar" });
    const ownerDetail = await store.getJarDetail(jar.id, owner.id);
    if (!ownerDetail) throw new Error("created private streak jar detail missing");
    await store.joinJarByCode(member.id, ownerDetail.inviteCode);
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
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not_member" });
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
  it("persists image evidence, creates a pending report, and resolves as owned", async () => {
    const accuser = await store.createUser({ name: "Iris" });
    const accused = await store.createUser({ name: "Jack" });
    const jar = await store.createJar({ userId: accuser.id, name: "Report Jar", rule: "" });
    const detail = await store.getJarDetail(jar.id, accuser.id);
    if (!detail) throw new Error("created report jar detail missing");
    await store.joinJarByCode(accused.id, detail.inviteCode);

    const report = await store.createReport({
      jarId: jar.id,
      accuserId: accuser.id,
      accusedId: accused.id,
      note: "saw it",
      anonymous: false,
      amountCents: 500,
      evidence: [
        {
          mimeType: "image/png",
          dataUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        },
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

  it("denies a report", async () => {
    const accuser = await store.createUser({ name: "Karen" });
    const accused = await store.createUser({ name: "Leo" });
    const jar = await store.createJar({ userId: accuser.id, name: "Deny Jar", rule: "" });
    const detail = await store.getJarDetail(jar.id, accuser.id);
    if (!detail) throw new Error("created deny jar detail missing");
    await store.joinJarByCode(accused.id, detail.inviteCode);

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

  it("redacts an anonymous reporter from activity while retaining the protected reporter id", async () => {
    const accuser = await store.createUser({ name: "Private Reporter" });
    const accused = await store.createUser({ name: "Reported Member" });
    const jar = await store.createJar({ userId: accuser.id, name: "Anonymous Report Jar" });
    const detail = await store.getJarDetail(jar.id, accuser.id);
    if (!detail) throw new Error("created anonymous report jar detail missing");
    await store.joinJarByCode(accused.id, detail.inviteCode);

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
    await store.joinJarByCode(member.id, detail.inviteCode);
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
});
