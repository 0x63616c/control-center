import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../db/index";
import { runMigrations } from "../db/migrate";
import * as store from "../store";

// DB-integration suite: requires a real Postgres (DATABASE_URL). The default unit
// gate has no DB, so these skip and the hooks no-op; the db layer still imports
// (buildDatabaseUrl returns undefined when unconfigured rather than throwing).
// Locally: DATABASE_URL=postgresql://postgres:test@localhost:5432/tye_test bun run test --project tye-api
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
});

describe.skipIf(!HAS_DB)("jar lifecycle", () => {
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
    const code = detail!.inviteCode;

    const joiner = await store.createUser({ name: "Grace" });
    const result = await store.joinJarByCode(joiner.id, code);
    expect(result).not.toBeNull();
    expect(result!.jarId).toBe(jar.id);

    const members = (await store.getJarDetail(jar.id, owner.id))!.members;
    expect(members).toHaveLength(2);
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
  it("creates pending report and resolves as owned", async () => {
    const accuser = await store.createUser({ name: "Iris" });
    const accused = await store.createUser({ name: "Jack" });
    const jar = await store.createJar({ userId: accuser.id, name: "Report Jar", rule: "" });
    const detail = await store.getJarDetail(jar.id, accuser.id);
    await store.joinJarByCode(accused.id, detail!.inviteCode);

    const report = await store.createReport({
      jarId: jar.id,
      accuserId: accuser.id,
      accusedId: accused.id,
      note: "saw it",
      anonymous: false,
      amountCents: 500,
      evidence: [],
    });
    expect(report.status).toBe("pending");

    const pending = await store.pendingReportsForUser(accused.id);
    expect(pending).toHaveLength(1);

    const resolved = await store.resolveReport(report.id, accused.id, "own");
    expect(resolved!.status).toBe("owned");

    const jars = await store.listJarsForUser(accused.id);
    const tally = jars.find((j) => j.id === jar.id)!.myTallyCents;
    expect(tally).toBe(500);
  });

  it("denies a report", async () => {
    const accuser = await store.createUser({ name: "Karen" });
    const accused = await store.createUser({ name: "Leo" });
    const jar = await store.createJar({ userId: accuser.id, name: "Deny Jar", rule: "" });
    const detail = await store.getJarDetail(jar.id, accuser.id);
    await store.joinJarByCode(accused.id, detail!.inviteCode);

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
    expect(denied!.status).toBe("denied");
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
});
