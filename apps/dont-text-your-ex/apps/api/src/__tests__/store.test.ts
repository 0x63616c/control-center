import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JarDetailSchema, ReportSchema } from "../../../../contracts";
import { pool } from "../db/index";
import { runMigrations } from "../db/migrate";
import { buildApp } from "../server";
import * as store from "../store";

// DB-integration suite: requires a real Postgres (DATABASE_URL). The default unit
// gate has no DB, so these skip and the hooks no-op; the db layer still imports
// (buildDatabaseUrl returns undefined when unconfigured rather than throwing).
// Locally: DATABASE_URL=postgresql://postgres:test@localhost:5432/tye_test bun run test --project dont-text-your-ex-api
const HAS_DB = !!process.env.DATABASE_URL;

function requireInviteCode(detail: Awaited<ReturnType<typeof store.getJarDetail>>): string {
  if (!detail?.inviteCode) throw new Error("open jar invite missing");
  return detail.inviteCode;
}

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
});

describe.skipIf(!HAS_DB)("jar lifecycle", () => {
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

    const preview = await store.getJarPreviewByCode(code);
    expect(preview?.members).toEqual([expect.objectContaining({ id: owner.id, name: "Frank" })]);
    expect(preview?.members[0]).not.toHaveProperty("exes");

    const joiner = await store.createUser({ name: "Grace" });
    const result = await store.joinJarByCode(joiner.id, code);
    expect(result).not.toBeNull();
    expect(result?.jarId).toBe(jar.id);

    const joinedDetail = await store.getJarDetail(jar.id, owner.id);
    expect(joinedDetail?.members).toHaveLength(2);
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
    expect(await store.getJarPreviewByCode(openDetail.inviteCode)).toBeNull();
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
    expect(await store.getJarPreviewByCode(code)).toMatchObject({
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
        }),
      ]),
    );
    const denied = await buildApp().request(`/api/jars/${jar.id}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "not_found" });
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
        {
          mimeType: "image/png",
          dataUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        },
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
    expect((await memberListResponse.json()) as unknown[]).toHaveLength(2);

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
    const actors = { owner, member, accused, former, outsider } as const;
    const tokens = {
      owner: await store.createSession(owner.id),
      member: await store.createSession(member.id),
      accused: await store.createSession(accused.id),
      former: await store.createSession(former.id),
      outsider: await store.createSession(outsider.id),
    } as const;
    type Actor = keyof typeof actors;

    const request = (actor: Actor, path: string, method = "GET", body?: unknown) =>
      buildApp().request(`/api${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${tokens[actor]}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const expectStatuses = async (
      path: string,
      expected: Readonly<Record<Actor, number>>,
      method = "GET",
      body?: unknown,
    ) => {
      for (const actor of Object.keys(actors) as Actor[]) {
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

    for (const actor of Object.keys(actors) as Actor[]) {
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
    for (const actor of Object.keys(actors) as Actor[]) {
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
});
