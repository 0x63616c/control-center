import { createHash } from "node:crypto";
import { createNotificationStore, createTokenCipher } from "@dont-text-your-ex/notifications";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PushInstallationIdSchema, UserIdSchema } from "../../../contracts";
import { pool as migrationPool } from "../../api/src/db/index";
import { runMigrations } from "../../api/src/db/migrate";
import { DomainTransactionRunner } from "../../api/src/domain-transaction";
import { buildDatabaseUrl } from "../../api/src/env";
import { PostgresStreakSweepStore } from "./streak-milestones";

const databaseUrl = buildDatabaseUrl();
const HAS_DB = databaseUrl !== undefined;
const pool = new Pool({ connectionString: databaseUrl });
const store = new PostgresStreakSweepStore(new DomainTransactionRunner({ pool }));

const at = (iso: string) => Date.parse(iso);
const fixed = (prefix: string, value: string) =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

async function insertEligibleMembership(input: {
  readonly suffix: string;
  readonly timezone: string;
  readonly streakStart: number | null;
  readonly joinedAt?: number;
  readonly shareStreak?: boolean;
  readonly notifications?: boolean;
  readonly leftAt?: number | null;
  readonly closedAt?: number | null;
}) {
  const userId = `usr_${input.suffix}`;
  const jarId = `jar_${input.suffix}`;
  const membershipId = `mem_${input.suffix}`;
  await pool.query(`INSERT INTO users (id,name,timezone,created_at) VALUES ($1,$2,$3,$4)`, [
    userId,
    "Streak tester",
    input.timezone,
    input.joinedAt ?? 1,
  ]);
  await pool.query(
    `INSERT INTO jars
       (id,name,created_by,invite_version_id,timezone,created_at,closed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      jarId,
      "Streak jar",
      userId,
      fixed("inv", input.suffix),
      input.timezone,
      input.joinedAt ?? 1,
      input.closedAt ?? null,
    ],
  );
  await pool.query(
    `INSERT INTO memberships
       (id,jar_id,user_id,streak_start_at,share_streak,joined_at,left_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      membershipId,
      jarId,
      userId,
      input.streakStart,
      input.shareStreak ? 1 : 0,
      input.joinedAt ?? 1,
      input.leftAt ?? null,
    ],
  );
  if (input.notifications !== undefined) {
    await pool.query(
      `INSERT INTO notification_preference (user_id,category,enabled,updated_at)
       VALUES ($1,'streak_milestone',$2,1)`,
      [userId, input.notifications],
    );
  }
  return { userId, jarId, membershipId };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  await runMigrations();
});

beforeEach(async () => {
  if (!HAS_DB) return;
  await pool.query(
    `TRUNCATE domain_event,notification_delivery,user_notification,push_device,
       notification_preference,streak_achievements,jar_milestones,membership_tenures,
       report_evidence,reports,activity,slips,memberships,sessions,otps,user_exes,jars,users
     RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await pool.end();
  await migrationPool.end();
});

describe.skipIf(!HAS_DB)("Postgres streak milestone sweep", () => {
  it("handles spring-forward local days, stays private by default, and remains idempotent after timezone change", async () => {
    const member = await insertEligibleMembership({
      suffix: "spring",
      timezone: "America/Los_Angeles",
      streakStart: at("2025-03-02T18:00:00.000Z"),
      notifications: false,
      shareStreak: false,
    });
    const cutoff = at("2025-03-09T16:30:00.000Z"); // 09:30 after the DST jump.

    await expect(store.processPage({ cutoff, limit: 100 })).resolves.toMatchObject({
      candidates: 1,
      achievements: 1,
      notifications: 0,
      sharedActivities: 0,
      hasMore: false,
    });
    await expect(store.processPage({ cutoff, limit: 100 })).resolves.toMatchObject({
      achievements: 0,
    });
    await pool.query("UPDATE users SET timezone='America/New_York' WHERE id=$1", [member.userId]);
    await expect(store.processPage({ cutoff, limit: 100 })).resolves.toMatchObject({
      achievements: 0,
    });

    expect((await pool.query("SELECT 1 FROM streak_achievements")).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM user_notification")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM activity")).rowCount).toBe(0);
  });

  it("handles fall-back once, creates current opt-in effects, and suppresses a reset after delivery preparation", async () => {
    const member = await insertEligibleMembership({
      suffix: "fallback",
      timezone: "America/Los_Angeles",
      streakStart: at("2025-10-26T17:00:00.000Z"),
      notifications: true,
      shareStreak: true,
    });
    const notificationStore = createNotificationStore(
      pool,
      createTokenCipher({ activeKeyId: "test", keys: { test: Buffer.alloc(32, 7) } }),
      () => at("2025-11-02T17:30:00.000Z"),
    );
    await notificationStore.registerDevice(UserIdSchema.parse(member.userId), {
      installationId: PushInstallationIdSchema.parse("dev_fallback"),
      token: "ab".repeat(32),
      platform: "ios",
      environment: "production",
      appVersion: "1.0",
      appBuild: "25",
    });
    const cutoff = at("2025-11-02T17:30:00.000Z"); // 09:30 after the repeated hour.

    await expect(store.processPage({ cutoff, limit: 100 })).resolves.toMatchObject({
      achievements: 1,
      notifications: 1,
      sharedActivities: 1,
    });
    const notification = await pool.query<{ id: string }>("SELECT id FROM user_notification");
    const notificationId = notification.rows[0]?.id;
    if (!notificationId) throw new Error("test notification missing");
    const deliveries = await notificationStore.prepareDeliveries(notificationId as never);
    expect(deliveries).toHaveLength(1);

    await pool.query("UPDATE memberships SET streak_start_at=$1 WHERE id=$2", [
      cutoff,
      member.membershipId,
    ]);
    await expect(notificationStore.loadDelivery(deliveries[0] as never)).resolves.toEqual({
      kind: "terminal",
      state: "suppressed",
    });
    expect(
      (await pool.query("SELECT 1 FROM activity WHERE text LIKE '%7-day clean streak%'")).rowCount,
    ).toBe(1);
  });

  it("skips before 09:00, null streaks, departed members, and closed jars", async () => {
    await insertEligibleMembership({
      suffix: "early",
      timezone: "America/Los_Angeles",
      streakStart: at("2025-02-23T18:00:00.000Z"),
    });
    await insertEligibleMembership({ suffix: "nullstreak", timezone: "UTC", streakStart: null });
    await insertEligibleMembership({
      suffix: "departed",
      timezone: "UTC",
      streakStart: at("2025-02-23T10:00:00.000Z"),
      leftAt: at("2025-03-01T00:00:00.000Z"),
    });
    await insertEligibleMembership({
      suffix: "closed",
      timezone: "UTC",
      streakStart: at("2025-02-23T10:00:00.000Z"),
      closedAt: at("2025-03-01T00:00:00.000Z"),
    });

    await expect(
      store.processPage({ cutoff: at("2025-03-02T16:59:00.000Z"), limit: 100 }),
    ).resolves.toMatchObject({ candidates: 0, achievements: 0 });
  });

  it("allows a genuine post-reset streak to earn the same milestone without backfilling a later opt-in", async () => {
    const member = await insertEligibleMembership({
      suffix: "repeat",
      timezone: "UTC",
      streakStart: at("2025-01-01T10:00:00.000Z"),
      notifications: false,
    });
    await store.processPage({ cutoff: at("2025-01-08T10:00:00.000Z"), limit: 100 });
    await pool.query(
      "UPDATE notification_preference SET enabled=TRUE WHERE user_id=$1 AND category='streak_milestone'",
      [member.userId],
    );
    await store.processPage({ cutoff: at("2025-01-08T11:00:00.000Z"), limit: 100 });
    expect((await pool.query("SELECT 1 FROM user_notification")).rowCount).toBe(0);

    await pool.query("UPDATE memberships SET streak_start_at=$1 WHERE id=$2", [
      at("2025-02-01T10:00:00.000Z"),
      member.membershipId,
    ]);
    await expect(
      store.processPage({ cutoff: at("2025-02-08T10:00:00.000Z"), limit: 100 }),
    ).resolves.toMatchObject({ achievements: 1, notifications: 1 });
    expect((await pool.query("SELECT 1 FROM streak_achievements")).rowCount).toBe(2);
  });

  it("pages a large due set in stable membership order", async () => {
    for (let index = 0; index < 205; index += 1) {
      await insertEligibleMembership({
        suffix: `page${index.toString().padStart(3, "0")}`,
        timezone: "UTC",
        streakStart: at("2025-01-01T10:00:00.000Z"),
      });
    }
    const cutoff = at("2025-01-08T10:00:00.000Z");
    const first = await store.processPage({ cutoff, limit: 100 });
    expect(first).toMatchObject({ candidates: 100, achievements: 100, hasMore: true });
    if (!first.nextCursor) throw new Error("first page cursor missing");
    const second = await store.processPage({ cutoff, cursor: first.nextCursor, limit: 100 });
    expect(second).toMatchObject({ candidates: 100, achievements: 100, hasMore: true });
    if (!second.nextCursor) throw new Error("second page cursor missing");
    const third = await store.processPage({ cutoff, cursor: second.nextCursor, limit: 100 });
    expect(third).toMatchObject({ candidates: 5, achievements: 5, hasMore: false });
    expect((await pool.query("SELECT 1 FROM streak_achievements")).rowCount).toBe(205);
  }, 15_000);

  it("rejects non-IANA database timezone updates", async () => {
    const member = await insertEligibleMembership({
      suffix: "zone",
      timezone: "UTC",
      streakStart: null,
    });
    await expect(
      pool.query("UPDATE users SET timezone='PST' WHERE id=$1", [member.userId]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
