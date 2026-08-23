import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate";
import {
  createModerationNarrativeCipher,
  installModerationStore,
  PostgresModerationStore,
  parseModerationNarrativeKeyring,
} from "../moderation";
import { buildApp } from "../server";

const databaseUrl = process.env.DATABASE_URL;
const HAS_DB = databaseUrl !== undefined;
const pool = new Pool({ connectionString: databaseUrl });

beforeAll(async () => {
  if (!HAS_DB) return;
  await runMigrations();
  installModerationStore(
    new PostgresModerationStore(
      pool,
      createModerationNarrativeCipher(
        parseModerationNarrativeKeyring({
          activeKeyId: "test-v1",
          keys: { "test-v1": Buffer.alloc(32, 41).toString("base64") },
        }),
      ),
    ),
  );
});

beforeEach(async () => {
  if (!HAS_DB) return;
  await pool.query(
    `TRUNCATE abuse_report_audit_event,abuse_report,report_evidence,reports,
       memberships,jars,sessions,users RESTART IDENTITY CASCADE`,
  );
  await pool.query(`
    INSERT INTO users (id,name,created_at) VALUES
      ('usr_reporter','Reporter',1),
      ('usr_target','Target',1),
      ('usr_other','Other member',1),
      ('usr_bystander','Bystander',1),
      ('usr_outsider','Outsider',1);
    INSERT INTO sessions (token,user_id,created_at,expires_at,last_used_at) VALUES
      ('sess_reporter','usr_reporter',1,9999999999999,1),
      ('sess_other','usr_other',1,9999999999999,1),
      ('sess_outsider','usr_outsider',1,9999999999999,1);
    INSERT INTO jars
      (id,name,created_by,invite_code,invite_expires_at,invite_version_id,timezone,created_at)
    VALUES
      ('jar_shared','Shared','usr_reporter','ABC234',9999999999999,'inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','UTC',1),
      ('jar_unrelated','Unrelated','usr_outsider','DEF567',9999999999999,'inv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','UTC',1);
    INSERT INTO memberships
      (id,jar_id,user_id,role,tally_cents,share_streak,joined_at) VALUES
      ('mem_reporter','jar_shared','usr_reporter','owner',0,1,1),
      ('mem_target','jar_shared','usr_target','member',0,1,1),
      ('mem_other','jar_shared','usr_other','member',0,1,1),
      ('mem_bystander','jar_shared','usr_bystander','member',0,1,1),
      ('mem_outsider','jar_unrelated','usr_outsider','owner',0,1,1);
    INSERT INTO reports
      (id,jar_id,accuser_id,accused_id,note,is_anonymous,amount_cents,status,created_at)
    VALUES
      ('rpt_gameplay','jar_shared','usr_other','usr_target','Existing gameplay note',0,500,'pending',2);
    INSERT INTO report_evidence (id,report_id,kind,payload,created_at)
    VALUES (
      'evi_gameplay','rpt_gameplay','image',
      '{"mimeType":"image/png","dataUrl":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}',2
    );
  `);
});

afterAll(async () => {
  await pool.end();
});

const reporterAuth = {
  Authorization: "Bearer sess_reporter",
  "Content-Type": "application/json",
};

describe.skipIf(!HAS_DB)("abuse moderation HTTP boundary", () => {
  it("accepts an authorized abuse report as an opaque receipt separate from gameplay reports", async () => {
    const response = await buildApp().request("/api/moderation/reports", {
      method: "POST",
      headers: reporterAuth,
      body: JSON.stringify({
        targetUserId: "usr_target",
        narrative: "Repeated hostile messages",
        reference: { jarId: "jar_shared", gameplayReportId: "rpt_gameplay" },
      }),
    });

    expect(response.status).toBe(202);
    const receipt = (await response.json()) as Record<string, unknown>;
    expect(receipt).toEqual({
      receiptId: expect.stringMatching(/^abr_[a-f0-9]{32}$/),
      status: "received",
    });
    expect(JSON.stringify(receipt)).not.toContain("Repeated hostile messages");
    expect(JSON.stringify(receipt)).not.toContain("usr_reporter");
    expect(JSON.stringify(receipt)).not.toContain("submitted");

    const persisted = await pool.query(
      `SELECT reporter_user_id,target_user_id,narrative_ciphertext,narrative_nonce,
              narrative_key_version,referenced_jar_id,referenced_gameplay_report_id,status
       FROM abuse_report WHERE id=$1`,
      [receipt.receiptId],
    );
    expect(persisted.rows).toEqual([
      {
        reporter_user_id: "usr_reporter",
        target_user_id: "usr_target",
        narrative_ciphertext: expect.any(String),
        narrative_nonce: expect.any(String),
        narrative_key_version: "test-v1",
        referenced_jar_id: "jar_shared",
        referenced_gameplay_report_id: "rpt_gameplay",
        status: "submitted",
      },
    ]);
    expect(JSON.stringify(persisted.rows)).not.toContain("Repeated hostile messages");
    expect(JSON.stringify(persisted.rows)).not.toContain("iVBORw0KGgo");
    await expect(
      pool.query(
        "SELECT event_type,actor_user_id FROM abuse_report_audit_event WHERE abuse_report_id=$1",
        [receipt.receiptId],
      ),
    ).resolves.toMatchObject({
      rows: [{ event_type: "submitted", actor_user_id: "usr_reporter" }],
    });

    const gameplay = await buildApp().request("/api/reports/rpt_gameplay", {
      headers: { Authorization: "Bearer sess_reporter" },
    });
    expect(gameplay.status).toBe(200);
    expect(await gameplay.json()).toMatchObject({
      id: "rpt_gameplay",
      note: "Existing gameplay note",
    });
  });

  it("rejects self, unrelated, unauthorized-reference, inline-evidence, and empty submissions", async () => {
    const cases: ReadonlyArray<{
      name: string;
      auth?: string;
      body: Record<string, unknown>;
      status: number;
    }> = [
      {
        name: "unauthenticated",
        body: { targetUserId: "usr_target", narrative: "Narrative" },
        status: 401,
      },
      {
        name: "self report",
        auth: "sess_reporter",
        body: { targetUserId: "usr_reporter", narrative: "Narrative" },
        status: 400,
      },
      {
        name: "unrelated target",
        auth: "sess_reporter",
        body: { targetUserId: "usr_outsider", narrative: "Narrative" },
        status: 404,
      },
      {
        name: "unavailable jar reference",
        auth: "sess_reporter",
        body: {
          targetUserId: "usr_target",
          reference: { jarId: "jar_unrelated" },
        },
        status: 404,
      },
      {
        name: "reference unrelated to target",
        auth: "sess_reporter",
        body: {
          targetUserId: "usr_bystander",
          reference: { gameplayReportId: "rpt_gameplay" },
        },
        status: 404,
      },
      {
        name: "authorized reference without narrative",
        auth: "sess_reporter",
        body: {
          targetUserId: "usr_target",
          reference: { gameplayReportId: "rpt_gameplay" },
        },
        status: 202,
      },
      {
        name: "inline evidence",
        auth: "sess_reporter",
        body: {
          targetUserId: "usr_target",
          narrative: "Narrative",
          evidence: [{ dataUrl: "data:image/png;base64,private" }],
        },
        status: 400,
      },
      {
        name: "empty",
        auth: "sess_reporter",
        body: { targetUserId: "usr_target" },
        status: 400,
      },
    ];

    for (const scenario of cases) {
      const response = await buildApp().request("/api/moderation/reports", {
        method: "POST",
        headers: scenario.auth
          ? { Authorization: `Bearer ${scenario.auth}`, "Content-Type": "application/json" }
          : { "Content-Type": "application/json" },
        body: JSON.stringify(scenario.body),
      });
      expect(response.status, scenario.name).toBe(scenario.status);
    }

    expect((await pool.query("SELECT id FROM abuse_report")).rowCount).toBe(1);
  });

  it("exposes no public moderation read plane and enforces an append-only creation audit", async () => {
    const submitted = await buildApp().request("/api/moderation/reports", {
      method: "POST",
      headers: reporterAuth,
      body: JSON.stringify({ targetUserId: "usr_target", narrative: "Private narrative" }),
    });
    const receipt = (await submitted.json()) as { receiptId: string };

    for (const request of [
      buildApp().request("/api/moderation/reports", {
        headers: { Authorization: "Bearer sess_reporter" },
      }),
      buildApp().request(`/api/moderation/reports/${receipt.receiptId}`, {
        headers: { Authorization: "Bearer sess_reporter" },
      }),
      buildApp().request(`/api/moderation/reports/${receipt.receiptId}`, {
        headers: { Authorization: "Bearer sess_other" },
      }),
      buildApp().request("/api/moderation/reports/abr_00000000000000000000000000000000", {
        headers: { Authorization: "Bearer sess_outsider" },
      }),
      buildApp().request(`/api/moderation/reports/${receipt.receiptId}/resolve`, {
        method: "POST",
        headers: { Authorization: "Bearer sess_other", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolved" }),
      }),
    ]) {
      await expect(request).resolves.toMatchObject({ status: 404 });
    }

    await expect(
      pool.query(
        "UPDATE abuse_report_audit_event SET event_type='reviewing' WHERE abuse_report_id=$1",
        [receipt.receiptId],
      ),
    ).rejects.toThrow("abuse report audit events are immutable");
    await expect(
      pool.query("DELETE FROM abuse_report_audit_event WHERE abuse_report_id=$1", [
        receipt.receiptId,
      ]),
    ).rejects.toThrow("abuse report audit events are immutable");
    expect(
      (
        await pool.query(
          "SELECT event_type FROM abuse_report_audit_event WHERE abuse_report_id=$1",
          [receipt.receiptId],
        )
      ).rows,
    ).toEqual([{ event_type: "submitted" }]);
  });

  it("retains an authorized reference-only receipt after gameplay data is erased", async () => {
    const response = await buildApp().request("/api/moderation/reports", {
      method: "POST",
      headers: reporterAuth,
      body: JSON.stringify({
        targetUserId: "usr_target",
        reference: { gameplayReportId: "rpt_gameplay" },
      }),
    });
    expect(response.status).toBe(202);
    const receipt = (await response.json()) as { receiptId: string };

    await expect(pool.query("DELETE FROM reports WHERE id='rpt_gameplay'")).resolves.toMatchObject({
      rowCount: 1,
    });
    await expect(
      pool.query(
        `SELECT referenced_gameplay_report_id,status
         FROM abuse_report WHERE id=$1`,
        [receipt.receiptId],
      ),
    ).resolves.toMatchObject({
      rows: [{ referenced_gameplay_report_id: "rpt_gameplay", status: "submitted" }],
    });
  });

  it("erases the full moderation aggregate when either linked account is deleted", async () => {
    await pool.query(`
      INSERT INTO users (id,name,created_at) VALUES
        ('usr_delete_reporter','Deleting reporter',1),
        ('usr_delete_target','Deleting target',1),
        ('usr_keep_reporter','Kept reporter',1),
        ('usr_delete_target_two','Second deleting target',1);
      INSERT INTO abuse_report
        (id,reporter_user_id,target_user_id,narrative_ciphertext,narrative_nonce,
         narrative_key_version,status,created_at,updated_at)
      VALUES
        ('abr_11111111111111111111111111111111','usr_delete_reporter','usr_delete_target',
         'ciphertext','nonce','test-v1','submitted',1,1),
        ('abr_22222222222222222222222222222222','usr_keep_reporter','usr_delete_target_two',
         'ciphertext','nonce','test-v1','submitted',1,1);
      INSERT INTO abuse_report_audit_event
        (id,abuse_report_id,event_type,actor_user_id,created_at)
      VALUES
        ('mae_11111111111111111111111111111111','abr_11111111111111111111111111111111',
         'submitted','usr_delete_reporter',1),
        ('mae_22222222222222222222222222222222','abr_22222222222222222222222222222222',
         'submitted','usr_keep_reporter',1);
    `);

    await expect(
      pool.query("DELETE FROM users WHERE id='usr_delete_reporter'"),
    ).resolves.toMatchObject({
      rowCount: 1,
    });
    await expect(
      pool.query("DELETE FROM users WHERE id='usr_delete_target_two'"),
    ).resolves.toMatchObject({
      rowCount: 1,
    });
    expect(
      (
        await pool.query(
          `SELECT id FROM abuse_report
           WHERE id IN ('abr_11111111111111111111111111111111','abr_22222222222222222222222222222222')`,
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pool.query(
          `SELECT id FROM abuse_report_audit_event
           WHERE abuse_report_id IN ('abr_11111111111111111111111111111111','abr_22222222222222222222222222222222')`,
        )
      ).rows,
    ).toEqual([]);
  });
});
