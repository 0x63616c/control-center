import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RecapIdSchema, UserIdSchema } from "../../../contracts";
import { pool } from "../../api/src/db/index";
import { runMigrations } from "../../api/src/db/migrate";
import { DomainTransactionRunner } from "../../api/src/domain-transaction";
import { buildDatabaseUrl } from "../../api/src/env";
import { getRecap, listRecaps } from "../../api/src/recap-store";
import { buildApp } from "../../api/src/server";
import { PostgresMonthlyRecapStore } from "./monthly-recaps";

const HAS_DB = buildDatabaseUrl() !== undefined;
const JULY_START = 1_782_889_200_000;
const AUGUST_START = 1_785_567_600_000;
const SEPTEMBER_START = 1_788_246_000_000;
const ownerId = UserIdSchema.parse("usr_recapowner");
const currentId = UserIdSchema.parse("usr_recapcurrent");
const departedId = UserIdSchema.parse("usr_recapdeparted");
const lateId = UserIdSchema.parse("usr_recaplate");
const rejoinedId = UserIdSchema.parse("usr_recaprejoined");

describe.skipIf(!HAS_DB)("PostgresMonthlyRecapStore", () => {
  beforeAll(runMigrations);
  beforeEach(async () => {
    await pool.query(
      `TRUNCATE domain_event,jar_recap_recipients,jar_recap_work_pages,jar_recaps,streak_achievements,
         user_notification,notification_preference,jar_milestones,membership_tenures,
         report_evidence,reports,activity,slips,memberships,sessions,otps,user_exes,jars,users
       RESTART IDENTITY CASCADE`,
    );
    await pool.query(
      `INSERT INTO users (id,name,timezone,created_at) VALUES
         ($1,'Owner','America/Los_Angeles',1),
         ($2,'Current','UTC',1),
         ($3,'Departed','UTC',1),
         ($4,'Late','UTC',1),
         ($5,'Rejoined','UTC',1)`,
      [ownerId, currentId, departedId, lateId, rejoinedId],
    );
    await pool.query(
      `INSERT INTO jars
         (id,name,created_by,invite_code,created_at,timezone,invite_version_id,closed_at)
       VALUES
         ('jar_recapactive','Recap jar',$1,'RECAP1',1,'America/Los_Angeles',
          'inv_11111111111111111111111111111111',$2),
         ('jar_recapsecond','Second recap jar',$1,'RECAP3',1,'America/Los_Angeles',
          'inv_33333333333333333333333333333333',NULL),
         ('jar_recapempty','Empty jar',$1,'RECAP2',1,'America/Los_Angeles',
          'inv_22222222222222222222222222222222',NULL)`,
      [ownerId, AUGUST_START + 1],
    );
    await pool.query(
      `INSERT INTO memberships (id,jar_id,user_id,role,share_streak,joined_at,left_at) VALUES
         ('mem_recapowner','jar_recapactive',$1,'owner',1,$6,NULL),
         ('mem_recapcurrent','jar_recapactive',$2,'member',1,$7,NULL),
         ('mem_recapdeparted','jar_recapactive',$3,'member',1,$6,$8),
         ('mem_recaplate','jar_recapactive',$4,'member',1,$9,NULL),
         ('mem_recaprejoined','jar_recapactive',$5,'member',1,$6,NULL),
         ('mem_recapsecond','jar_recapsecond',$1,'owner',1,$6,NULL)`,
      [
        ownerId,
        currentId,
        departedId,
        lateId,
        rejoinedId,
        JULY_START,
        JULY_START + 10 * 86_400_000,
        AUGUST_START + 5 * 86_400_000,
        SEPTEMBER_START,
      ],
    );
    await pool.query(
      `INSERT INTO membership_tenures (id,membership_id,joined_at,left_at) VALUES
         ('mtn_11111111111111111111111111111111','mem_recapowner',$1,NULL),
         ('mtn_22222222222222222222222222222222','mem_recapcurrent',$2,NULL),
         ('mtn_33333333333333333333333333333333','mem_recapdeparted',$1,$3),
         ('mtn_44444444444444444444444444444444','mem_recaplate',$4,NULL),
         ('mtn_55555555555555555555555555555555','mem_recaprejoined',$1,$5),
         ('mtn_66666666666666666666666666666666','mem_recaprejoined',$4,NULL),
         ('mtn_77777777777777777777777777777777','mem_recapsecond',$1,NULL)`,
      [
        JULY_START,
        JULY_START + 10 * 86_400_000,
        AUGUST_START + 5 * 86_400_000,
        SEPTEMBER_START,
        JULY_START + 5 * 86_400_000,
      ],
    );
    await pool.query(
      `INSERT INTO activity (id,jar_id,actor_id,target_id,type,created_at) VALUES
         ('act_recapstart','jar_recapactive',$1,$1,'slip',$2),
         ('act_recapend','jar_recapactive',$2,$2,'slip',$3),
         ('act_recapaugust','jar_recapactive',$1,$1,'slip',$4),
         ('act_recapstreak1','jar_recapactive',$1,$1,'milestone',$5),
         ('act_recapstreak2','jar_recapactive',$2,$2,'milestone',$6),
         ('act_recapsecond','jar_recapsecond',$1,$1,'slip',$2)`,
      [
        ownerId,
        JULY_START,
        AUGUST_START - 1,
        AUGUST_START,
        JULY_START + 7 * 86_400_000,
        JULY_START + 8 * 86_400_000,
      ],
    );
    await pool.query(
      `UPDATE activity SET text='Reached a 7-day clean streak.'
       WHERE id IN ('act_recapstreak1','act_recapstreak2')`,
    );
    await pool.query(
      `INSERT INTO slips (id,jar_id,user_id,amount_cents,created_at) VALUES
         ('slip_11111111111111111111111111111111','jar_recapactive',$1,500,$3),
         ('slip_22222222222222222222222222222222','jar_recapactive',$2,700,$4),
         ('slip_33333333333333333333333333333333','jar_recapactive',$1,900,$5)`,
      [ownerId, currentId, JULY_START, AUGUST_START - 1, AUGUST_START],
    );
    await pool.query(
      `INSERT INTO jar_milestones (id,jar_id,threshold_cents,reached_at) VALUES
         ('jms_11111111111111111111111111111111','jar_recapactive',1000,$1)`,
      [JULY_START + 100],
    );
    await pool.query(
      `INSERT INTO streak_achievements
         (id,membership_id,streak_started_at,milestone_days,reached_local_date,created_at)
       VALUES
         ('sta_11111111111111111111111111111111','mem_recapowner',$1,7,'2026-07-08',$2),
         ('sta_22222222222222222222222222222222','mem_recapcurrent',$1,7,'2026-07-09',$2)`,
      [JULY_START, JULY_START + 8 * 86_400_000],
    );
    await pool.query(
      `INSERT INTO notification_preference (user_id,category,enabled,updated_at)
       VALUES ($1,'recap',TRUE,1),($2,'recap',FALSE,1)`,
      [ownerId, currentId],
    );
  });

  afterAll(() => pool.end());

  it("creates immutable, exact, paged jar-month snapshots once", async () => {
    const store = new PostgresMonthlyRecapStore(new DomainTransactionRunner({ pool }));
    const pages = await store.preparePages({ cutoff: SEPTEMBER_START, limit: 24 });
    expect(pages.map((page) => page.calendarMonth)).toEqual(["2026-07", "2026-08"]);
    const julyPageId = pages[0]?.pageId;
    const augustPageId = pages[1]?.pageId;
    if (!julyPageId || !augustPageId) throw new Error("expected persisted recap work pages");
    await expect(store.generatePage({ pageId: julyPageId, limit: 1 })).resolves.toEqual({
      candidates: 1,
      recaps: 1,
      recipients: 3,
      notifications: 1,
      hasMore: true,
    });
    await expect(store.generatePage({ pageId: julyPageId, limit: 1 })).resolves.toEqual({
      candidates: 1,
      recaps: 1,
      recipients: 1,
      notifications: 1,
      hasMore: false,
    });
    await expect(store.generatePage({ pageId: augustPageId, limit: 1 })).resolves.toMatchObject({
      candidates: 1,
      recaps: 1,
      hasMore: false,
    });
    await expect(store.preparePages({ cutoff: SEPTEMBER_START, limit: 24 })).resolves.toEqual([]);

    const snapshots = await pool.query<{
      id: string;
      calendar_month: string;
      period_start_at: string;
      period_end_at: string;
      slip_count: number;
      total_amount_cents: string;
      tally_change_cents: string;
      shared_streak_highlights: unknown;
      crossed_milestones_cents: unknown;
    }>("SELECT * FROM jar_recaps ORDER BY calendar_month,jar_id");
    expect(snapshots.rows[0]).toMatchObject({
      calendar_month: "2026-07",
      period_start_at: String(JULY_START),
      period_end_at: String(AUGUST_START),
      slip_count: 2,
      total_amount_cents: "1200",
      tally_change_cents: "1200",
      shared_streak_highlights: [{ days: 7, count: 2 }],
      crossed_milestones_cents: [1000],
    });
    expect(snapshots.rows[1]).toMatchObject({ calendar_month: "2026-07", slip_count: 0 });
    expect(snapshots.rows[2]).toMatchObject({ calendar_month: "2026-08", slip_count: 1 });
    await expect(
      pool.query("UPDATE jar_recaps SET slip_count=99 WHERE id=$1", [snapshots.rows[0]?.id]),
    ).rejects.toThrow("immutable");
    expect(
      (await pool.query("SELECT 1 FROM jar_recaps WHERE jar_id='jar_recapempty'")).rowCount,
    ).toBe(0);
    expect(
      (await pool.query("SELECT 1 FROM user_notification WHERE category='recap'")).rowCount,
    ).toBe(3);
    expect(
      (await pool.query("SELECT event_type FROM domain_event ORDER BY event_type")).rows.map(
        (row) => row.event_type,
      ),
    ).toEqual([
      "notification.requested",
      "notification.requested",
      "notification.requested",
      "recap.created",
      "recap.created",
      "recap.created",
    ]);

    await pool.query("UPDATE jars SET name='Renamed later' WHERE id='jar_recapactive'");
    expect(
      (await listRecaps(ownerId)).find((recap) => recap.id === snapshots.rows[0]?.id)?.jarName,
    ).toBe("Recap jar");
  });

  it("authorizes only a current recipient who overlapped the completed month", async () => {
    const store = new PostgresMonthlyRecapStore(new DomainTransactionRunner({ pool }));
    const [page] = await store.preparePages({ cutoff: AUGUST_START + 1, limit: 24 });
    if (!page) throw new Error("expected July recap page");
    await store.generatePage({ pageId: page.pageId, limit: 10 });
    const recapId = RecapIdSchema.parse(
      (await pool.query<{ id: string }>("SELECT id FROM jar_recaps WHERE jar_id='jar_recapactive'"))
        .rows[0]?.id,
    );

    await expect(listRecaps(ownerId)).resolves.toHaveLength(2);
    await expect(getRecap(currentId, recapId)).resolves.toMatchObject({ id: recapId });
    await expect(getRecap(rejoinedId, recapId)).resolves.toMatchObject({ id: recapId });
    await expect(getRecap(departedId, recapId)).resolves.toBeNull();
    await expect(getRecap(lateId, recapId)).resolves.toBeNull();

    const token = "sess_recapcurrent";
    await pool.query(
      `INSERT INTO sessions (token,user_id,created_at,last_used_at,expires_at)
       VALUES ($1,$2,$3,$3,$4)`,
      [token, currentId, Date.now(), Date.now() + 86_400_000],
    );
    const app = buildApp();
    await expect(
      app.request(`/api/recaps/${recapId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(app.request(`/api/recaps/${recapId}`)).resolves.toMatchObject({ status: 401 });

    await pool.query("UPDATE memberships SET left_at=$1 WHERE user_id=$2", [
      SEPTEMBER_START + 1,
      currentId,
    ]);
    await expect(getRecap(currentId, recapId)).resolves.toBeNull();
    await expect(
      app.request(`/api/recaps/${recapId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("uses the immutable jar timezone across a daylight-saving month boundary", async () => {
    const novemberStart = 1_793_516_400_000;
    const decemberStart = 1_796_112_000_000;
    await pool.query("DELETE FROM activity");
    await pool.query(
      `INSERT INTO activity (id,jar_id,actor_id,target_id,type,created_at)
       VALUES ('act_recapdst','jar_recapactive',$1,$1,'slip',$2)`,
      [ownerId, novemberStart],
    );
    const store = new PostgresMonthlyRecapStore(new DomainTransactionRunner({ pool }));
    const [page] = await store.preparePages({ cutoff: decemberStart, limit: 24 });
    if (!page) throw new Error("expected November recap page");
    await store.generatePage({ pageId: page.pageId, limit: 10 });

    const snapshot = await pool.query<{ period_start_at: string; period_end_at: string }>(
      "SELECT period_start_at::text,period_end_at::text FROM jar_recaps",
    );
    expect(snapshot.rows).toEqual([
      { period_start_at: String(novemberStart), period_end_at: String(decemberStart) },
    ]);
    expect(decemberStart - novemberStart).toBe(30 * 86_400_000 + 3_600_000);
  });
});
