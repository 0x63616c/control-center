import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AbuseReportIdSchema } from "../../../../contracts";
import { runMigrations } from "../db/migrate";
import { createModerationNarrativeCipher, parseModerationNarrativeKeyring } from "../moderation";
import { PostgresModerationAdminStore } from "../moderation-admin";
import { buildApp } from "../server";

const databaseUrl = process.env.DATABASE_URL;
const HAS_DB = databaseUrl !== undefined;
const pool = new Pool({ connectionString: databaseUrl });
const cipher = createModerationNarrativeCipher(
  parseModerationNarrativeKeyring({
    activeKeyId: "operator-test-v2",
    keys: { "operator-test-v2": Buffer.alloc(32, 91).toString("base64") },
  }),
);
const store = new PostgresModerationAdminStore(pool, cipher, () => 200);
const REPORT_ID = AbuseReportIdSchema.parse(`abr_${"a".repeat(32)}`);
const PRIVATE_NARRATIVE = "private narrative only explicit show may reveal";

beforeAll(async () => {
  if (HAS_DB) await runMigrations();
});

beforeEach(async () => {
  if (!HAS_DB) return;
  await pool.query(
    `TRUNCATE abuse_report_audit_event,abuse_report,sessions,users RESTART IDENTITY CASCADE`,
  );
  const sealed = cipher.seal(PRIVATE_NARRATIVE, REPORT_ID);
  await pool.query(
    `INSERT INTO users (id,name,created_at) VALUES
       ('usr_operatorreporter','Reporter',1),('usr_operatortarget','Target',1);
     INSERT INTO sessions (token,user_id,created_at,expires_at,last_used_at)
       VALUES ('sess_operatorreporter','usr_operatorreporter',1,9999999999999,1)`,
  );
  await pool.query(
    `INSERT INTO abuse_report
       (id,reporter_user_id,target_user_id,narrative_ciphertext,narrative_nonce,
        narrative_key_version,status,created_at,updated_at)
       VALUES ($1,'usr_operatorreporter','usr_operatortarget',$2,$3,$4,'submitted',10,10)`,
    [REPORT_ID, sealed.ciphertext, sealed.nonce, sealed.keyVersion],
  );
  await pool.query(
    `INSERT INTO abuse_report_audit_event
       (id,abuse_report_id,event_type,actor_user_id,created_at)
       VALUES ($1,$2,'submitted','usr_operatorreporter',10)`,
    [`mae_${"b".repeat(32)}`, REPORT_ID],
  );
});

afterAll(async () => {
  await pool.end();
});

describe.skipIf(!HAS_DB)("private moderation operator store", () => {
  it("lists a redacted queue and decrypts only an explicitly shown report", async () => {
    const queue = await store.listQueue();
    expect(queue).toEqual([
      {
        reportId: REPORT_ID,
        targetUserId: "usr_operatortarget",
        status: "submitted",
        hasNarrative: true,
        referencedJarId: null,
        referencedGameplayReportId: null,
        createdAt: 10,
        updatedAt: 10,
      },
    ]);
    expect(JSON.stringify(queue)).not.toContain(PRIVATE_NARRATIVE);
    expect(JSON.stringify(queue)).not.toContain("narrativeCiphertext");

    const shown = await store.show(REPORT_ID);
    expect(shown).toMatchObject({
      reportId: REPORT_ID,
      reporterUserId: "usr_operatorreporter",
      targetUserId: "usr_operatortarget",
      status: "submitted",
      narrative: PRIVATE_NARRATIVE,
      auditEvents: [
        {
          eventType: "submitted",
          actorIdentity: null,
          actorUserId: "usr_operatorreporter",
          createdAt: 10,
        },
      ],
    });

    const ordinaryUserRead = await buildApp().request(`/api/moderation/reports/${REPORT_ID}`, {
      headers: { Authorization: "Bearer sess_operatorreporter" },
    });
    expect(ordinaryUserRead.status).toBe(404);
  });

  it.each([
    "resolved",
    "dismissed",
  ] as const)("makes the submitted -> reviewing -> %s transition idempotent and auditable", async (terminalStatus) => {
    await expect(store.transition(REPORT_ID, "reviewing")).resolves.toEqual({
      reportId: REPORT_ID,
      status: "reviewing",
      changed: true,
    });
    await expect(store.listQueue()).resolves.toMatchObject([
      { reportId: REPORT_ID, status: "reviewing" },
    ]);
    await expect(store.transition(REPORT_ID, "reviewing")).resolves.toMatchObject({
      changed: false,
    });
    await expect(store.transition(REPORT_ID, terminalStatus)).resolves.toEqual({
      reportId: REPORT_ID,
      status: terminalStatus,
      changed: true,
    });
    await expect(store.transition(REPORT_ID, terminalStatus)).resolves.toMatchObject({
      changed: false,
    });
    await expect(store.listQueue()).resolves.toEqual([]);

    const shown = await store.show(REPORT_ID);
    expect(shown.status).toBe(terminalStatus);
    expect(shown.auditEvents).toEqual([
      {
        eventType: "submitted",
        actorIdentity: null,
        actorUserId: "usr_operatorreporter",
        createdAt: 10,
      },
      {
        eventType: "reviewing",
        actorIdentity: "operator:calum-peter-webb",
        actorUserId: null,
        createdAt: 200,
      },
      {
        eventType: terminalStatus,
        actorIdentity: "operator:calum-peter-webb",
        actorUserId: null,
        createdAt: 201,
      },
    ]);
    await expect(
      store.transition(REPORT_ID, terminalStatus === "resolved" ? "dismissed" : "resolved"),
    ).rejects.toMatchObject({ code: "invalid_status_transition" });
    await expect(
      pool.query(
        `UPDATE abuse_report_audit_event SET actor_identity='operator:someone-else'
           WHERE abuse_report_id=$1 AND event_type='reviewing'`,
        [REPORT_ID],
      ),
    ).rejects.toThrow("abuse report audit events are immutable");
  });
});
