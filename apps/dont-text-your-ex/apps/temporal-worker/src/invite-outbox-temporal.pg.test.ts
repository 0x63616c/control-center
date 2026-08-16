import { createRequire } from "node:module";
import {
  createNotificationStore,
  createTokenCipher,
  parseTokenKeyring,
} from "@dont-text-your-ex/notifications";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PushInstallationIdSchema } from "../../../contracts";
import { pool } from "../../api/src/db/index";
import { runMigrations } from "../../api/src/db/migrate";
import { InviteVersionIdSchema } from "../../api/src/domain-events";
import { DomainTransactionRunner } from "../../api/src/domain-transaction";
import { buildDatabaseUrl } from "../../api/src/env";
import { PostgresOutbox } from "../../api/src/outbox";
import * as productStore from "../../api/src/store";
import { dispatchOutboxPage } from "../../api/src/workflow-dispatcher";
import { createInviteLifecycleActivities, PostgresInviteLifecycleStore } from "./invite-lifecycle";
import { WORKFLOW_TYPES } from "./registry";
import {
  registeredTemporalEventHandlers,
  TemporalClientWorkflowGateway,
  TemporalWorkflowDispatcher,
} from "./temporal-workflow-dispatcher";

const HAS_DB = buildDatabaseUrl() !== undefined;
const workflowsPath = new URL("./workflows.ts", import.meta.url).pathname;
const require = createRequire(import.meta.url);
const testingEntry = require.resolve("@temporalio/testing");
const testingRequire = createRequire(testingEntry);
const { Worker } = await import(testingRequire.resolve("@temporalio/worker"));
const environments: TestWorkflowEnvironment[] = [];

describe.skipIf(!HAS_DB).sequential("invite outbox to Temporal", () => {
  beforeAll(runMigrations);
  beforeEach(async () => {
    await pool.query(
      `TRUNCATE domain_event,jar_milestones,membership_tenures,report_evidence,reports,
         activity,slips,memberships,sessions,otps,user_exes,jars,users RESTART IDENTITY CASCADE`,
    );
  });
  afterEach(async () => {
    await Promise.all(environments.splice(0).map((environment) => environment.teardown()));
  });
  afterAll(() => pool.end());

  it("dispatches a transactionally emitted version id through main without exposing the invite", async () => {
    const owner = await productStore.createUser({ name: "Outbox Invite Owner" });
    const jar = await productStore.createJar({ userId: owner.id, name: "Outbox Invite Jar" });
    const persisted = await pool.query<{
      invite_code: string;
      invite_version_id: string;
    }>("SELECT invite_code,invite_version_id FROM jars WHERE id=$1", [jar.id]);
    const inviteCode = persisted.rows[0]?.invite_code;
    const inviteVersionId = InviteVersionIdSchema.parse(persisted.rows[0]?.invite_version_id);
    if (!inviteCode) throw new Error("fixture invite code missing");
    await pool.query("UPDATE jars SET invite_expires_at=$1 WHERE id=$2", [
      Date.now() + 60_000,
      jar.id,
    ]);
    const emitted = await pool.query<{ id: string; aggregate_id: string; state: string }>(
      `SELECT id,aggregate_id,state FROM domain_event
       WHERE event_type='invite.issued' AND aggregate_id=$1`,
      [inviteVersionId],
    );
    expect(emitted.rows).toEqual([
      expect.objectContaining({ aggregate_id: inviteVersionId, state: "pending" }),
    ]);
    const eventId = emitted.rows[0]?.id as never;

    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    environments.push(environment);
    const activities = createInviteLifecycleActivities(
      new PostgresInviteLifecycleStore(pool, new DomainTransactionRunner({ pool })),
    );
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: "main",
      workflowsPath,
      activities,
    });
    const dispatcher = new TemporalWorkflowDispatcher(
      registeredTemporalEventHandlers(
        new TemporalClientWorkflowGateway(environment.client),
        WORKFLOW_TYPES,
      ),
    );

    let history:
      | Awaited<
          ReturnType<ReturnType<typeof environment.client.workflow.getHandle>["fetchHistory"]>
        >
      | undefined;
    const result = await worker.runUntil(async () => {
      const dispatch = await dispatchOutboxPage({
        outbox: new PostgresOutbox(pool),
        dispatcher,
        owner: "invite-outbox-temporal-test",
        limit: 1,
        now: Date.now(),
        leaseUntil: Date.now() + 30_000,
        retryAt: Date.now() + 60_000,
        eventIds: [eventId],
      });
      expect(dispatch).toEqual({ claimed: 1, accepted: 1, retried: 0, failed: 0 });
      const handle = environment.client.workflow.getHandle(`invite/${inviteVersionId}`);
      const output = await handle.result();
      history = await handle.fetchHistory();
      return output;
    });

    expect(result).toBe("reminded");
    expect(
      await pool.query("SELECT 1 FROM domain_event WHERE id=$1 AND state='dispatched'", [eventId]),
    ).toMatchObject({ rowCount: 1 });
    const notifications = await pool.query<{
      id: string;
      recipient_user_id: string;
      category: string;
    }>("SELECT id,recipient_user_id,category FROM user_notification");
    expect(notifications.rows).toEqual([
      expect.objectContaining({ recipient_user_id: owner.id, category: "invite" }),
    ]);
    const notificationId = notifications.rows[0]?.id as never;

    const notificationStore = createNotificationStore(
      pool,
      createTokenCipher(
        parseTokenKeyring({
          activeKeyId: "test",
          keys: { test: Buffer.alloc(32, 8).toString("base64") },
        }),
      ),
    );
    await notificationStore.registerDevice(owner.id, {
      installationId: PushInstallationIdSchema.parse("dev_invitedefaultoff"),
      token: "ab".repeat(32),
      platform: "ios",
      environment: "sandbox",
      appVersion: "1.0",
      appBuild: "1",
    });
    expect((await notificationStore.getPreferences(owner.id)).invite).toBe(false);
    await expect(notificationStore.prepareDeliveries(notificationId)).resolves.toEqual([]);
    expect((await pool.query("SELECT 1 FROM notification_delivery")).rowCount).toBe(0);

    if (!history) throw new Error("workflow history missing");
    const startPayloads =
      history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads;
    const historyInput = (startPayloads ?? [])
      .map((payload) => new TextDecoder().decode(payload.data ?? undefined))
      .join("\n");
    expect(JSON.parse(historyInput)).toEqual({ schemaVersion: 1, inviteVersionId });
    expect(historyInput).not.toContain(inviteCode);
    expect(historyInput).not.toMatch(/invite_code|https?:\/\/|join\//i);
  }, 120_000);
});
