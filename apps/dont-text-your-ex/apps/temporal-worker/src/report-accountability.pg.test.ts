import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReportIdSchema, UserIdSchema } from "../../../contracts";
import { pool as migrationPool } from "../../api/src/db/index";
import { runMigrations } from "../../api/src/db/migrate";
import { buildDatabaseUrl } from "../../api/src/env";
import * as apiStore from "../../api/src/store";
import { PostgresReportAccountabilityStore } from "./report-accountability";

const databaseUrl = buildDatabaseUrl();
const HAS_DB = databaseUrl !== undefined;
const pool = new Pool({ connectionString: databaseUrl });
const reporterId = UserIdSchema.parse("usr_accountabilityreporter");
const accusedId = UserIdSchema.parse("usr_accountabilityaccused");
const jarId = "jar_accountability";

async function insertReport(reportId: string, createdAt: number): Promise<void> {
  await pool.query(
    `INSERT INTO reports
       (id,jar_id,accuser_id,accused_id,note,is_anonymous,amount_cents,status,created_at)
     VALUES ($1,$2,$3,$4,'private report text',1,500,'pending',$5)`,
    [reportId, jarId, reporterId, accusedId, createdAt],
  );
}

beforeAll(async () => {
  if (!HAS_DB) return;
  await runMigrations();
  await pool.query("DELETE FROM users WHERE id IN ($1,$2)", [reporterId, accusedId]);
  await pool.query(
    "INSERT INTO users (id,name,created_at) VALUES ($1,'Reporter',1),($2,'Accused',1)",
    [reporterId, accusedId],
  );
  await pool.query(
    `INSERT INTO jars
       (id,name,created_by,invite_code,created_at,invite_version_id)
     VALUES ($1,'Accountability',$2,'ACCT01',1,'inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`,
    [jarId, reporterId],
  );
  await pool.query(
    `INSERT INTO memberships (id,jar_id,user_id,role,joined_at)
     VALUES ('mem_accountabilityreporter',$1,$2,'owner',1),
            ('mem_accountabilityaccused',$1,$3,'member',1)`,
    [jarId, reporterId, accusedId],
  );
});

afterAll(async () => {
  if (HAS_DB) await pool.query("DELETE FROM users WHERE id IN ($1,$2)", [reporterId, accusedId]);
  await pool.end();
  await migrationPool.end();
});

describe.skipIf(!HAS_DB)("Postgres report accountability", () => {
  it("deduplicates reminders and atomically expires only a pending report", async () => {
    const reportId = ReportIdSchema.parse("rpt_11111111111111111111111111111111");
    const createdAt = 1_700_000_000_000;
    await insertReport(reportId, createdAt);
    const store = new PostgresReportAccountabilityStore(pool, () => createdAt + 7 * 86_400_000);

    await store.advance({ reportId, action: "remind_immediate" });
    await store.advance({ reportId, action: "remind_immediate" });
    await expect(store.advance({ reportId, action: "expire" })).resolves.toMatchObject({
      state: "expired",
      reportId,
      aggregateVersion: 2,
    });
    await expect(store.advance({ reportId, action: "expire" })).resolves.toMatchObject({
      state: "expired",
      aggregateVersion: 2,
    });

    const persisted = await pool.query<{
      status: string;
      aggregate_version: string;
      recipient_user_id: string;
      message_key: string;
    }>(
      `SELECT r.status,r.aggregate_version,n.recipient_user_id,n.message_key
       FROM reports r JOIN user_notification n ON n.target_id=r.id
       WHERE r.id=$1 ORDER BY n.message_key`,
      [reportId],
    );
    expect(persisted.rows).toEqual([
      {
        status: "expired",
        aggregate_version: "2",
        recipient_user_id: reporterId,
        message_key: "report.expired",
      },
      {
        status: "expired",
        aggregate_version: "2",
        recipient_user_id: accusedId,
        message_key: "report.pending",
      },
    ]);
    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM domain_event
       WHERE aggregate_id=$1 OR aggregate_id IN
         (SELECT id FROM user_notification WHERE target_id=$1)
       ORDER BY event_type`,
      [reportId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "notification.requested",
      "notification.requested",
      "report.expired",
    ]);
  });

  it("gives an own-versus-expire race one authoritative winner", async () => {
    const reportId = ReportIdSchema.parse("rpt_22222222222222222222222222222222");
    await insertReport(reportId, 1_700_000_000_000);
    const accountability = new PostgresReportAccountabilityStore(pool, () => 1_800_000_000_000);

    await Promise.all([
      accountability.advance({ reportId, action: "expire" }),
      apiStore.resolveReport(reportId, accusedId, "own"),
    ]);

    const report = await pool.query<{ status: "owned" | "expired" }>(
      "SELECT status FROM reports WHERE id=$1",
      [reportId],
    );
    const slipActivity = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM activity WHERE report_id=$1 AND type='slip'",
      [reportId],
    );
    const membership = await pool.query<{ tally_cents: number; streak_start_at: string | null }>(
      "SELECT tally_cents,streak_start_at FROM memberships WHERE jar_id=$1 AND user_id=$2",
      [jarId, accusedId],
    );
    if (report.rows[0]?.status === "owned") {
      expect(slipActivity.rows[0]?.count).toBe("1");
      expect(membership.rows[0]).toMatchObject({ tally_cents: 500, streak_start_at: null });
    } else {
      expect(report.rows[0]?.status).toBe("expired");
      expect(slipActivity.rows[0]?.count).toBe("0");
      expect(membership.rows[0]).toMatchObject({ tally_cents: 0, streak_start_at: null });
    }
  });

  it("ends harmlessly when the jar closes or the accused departs", async () => {
    const closedId = ReportIdSchema.parse("rpt_33333333333333333333333333333333");
    await insertReport(closedId, 1_700_000_000_000);
    await pool.query("UPDATE jars SET closed_at=2 WHERE id=$1", [jarId]);
    const store = new PostgresReportAccountabilityStore(pool, () => 3);
    await expect(
      store.advance({ reportId: closedId, action: "remind_24h" }),
    ).resolves.toMatchObject({ state: "jar_closed" });
    await pool.query("UPDATE jars SET closed_at=NULL WHERE id=$1", [jarId]);

    const departedId = ReportIdSchema.parse("rpt_44444444444444444444444444444444");
    await insertReport(departedId, 1_700_000_000_000);
    await pool.query("UPDATE memberships SET left_at=2 WHERE jar_id=$1 AND user_id=$2", [
      jarId,
      accusedId,
    ]);
    await expect(
      store.advance({ reportId: departedId, action: "remind_72h" }),
    ).resolves.toMatchObject({ state: "member_departed" });
    const notifications = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM user_notification WHERE target_id IN ($1,$2)",
      [closedId, departedId],
    );
    expect(notifications.rows[0]?.count).toBe("0");
  });
});
