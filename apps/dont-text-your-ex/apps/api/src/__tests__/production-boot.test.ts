import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../db/index";
import { runMigrations } from "../db/migrate";
import { resetEnvCache } from "../env";
import { ensureSeed } from "../seed";

// DB-integration suite, only runs with a real Postgres (DATABASE_URL); skips in
// the default unit gate. See store.test.ts for the rationale.
const HAS_DB = !!process.env.DATABASE_URL;

beforeAll(async () => {
  if (!HAS_DB) return;
  // Ensure the schema exists before the truncate in beforeEach (this file
  // otherwise only migrates inside the test bodies, which run after beforeEach).
  await runMigrations();
});

beforeEach(async () => {
  if (!HAS_DB) return;
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

describe.skipIf(!HAS_DB)("production boot", () => {
  it("ensureSeed does NOT insert rows when APP_ENV=production", async () => {
    const origEnv = process.env.APP_ENV;
    process.env.APP_ENV = "production";
    resetEnvCache();
    try {
      await runMigrations();
      await ensureSeed();
      const { rows } = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM users");
      expect(Number(rows[0].n)).toBe(0);
    } finally {
      if (origEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = origEnv;
      resetEnvCache();
    }
  });

  it("ensureSeed DOES insert rows when APP_ENV is not production", async () => {
    const origEnv = process.env.APP_ENV;
    process.env.APP_ENV = "development";
    resetEnvCache();
    try {
      await runMigrations();
      await ensureSeed();
      const { rows } = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM users");
      expect(Number(rows[0].n)).toBeGreaterThan(0);
    } finally {
      if (origEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = origEnv;
      resetEnvCache();
    }
  });
});
