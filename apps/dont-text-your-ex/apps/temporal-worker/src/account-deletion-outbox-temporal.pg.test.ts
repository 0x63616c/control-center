import { createRequire } from "node:module";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAccountDeletionCipher,
  PostgresAccountDeletionStore,
  parseAccountDeletionKeyring,
} from "../../api/src/account-deletion";
import { pool } from "../../api/src/db/index";
import { runMigrations } from "../../api/src/db/migrate";
import { DomainTransactionRunner } from "../../api/src/domain-transaction";
import { buildDatabaseUrl } from "../../api/src/env";
import { PostgresOutbox } from "../../api/src/outbox";
import * as apiStore from "../../api/src/store";
import { dispatchOutboxPage } from "../../api/src/workflow-dispatcher";
import {
  createAccountDeletionActivities,
  TemporalAccountDeletionWorkflowCleanupGateway,
} from "./account-deletion";
import {
  registeredTemporalEventHandlers,
  TemporalClientWorkflowGateway,
  TemporalWorkflowDispatcher,
} from "./temporal-workflow-dispatcher";
import { PostgresTemporalWorkflowFence } from "./workflow-dispatch-fence";

const HAS_DB = buildDatabaseUrl() !== undefined;
const workflowsPath = new URL("./workflows.ts", import.meta.url).pathname;
const require = createRequire(import.meta.url);
const testingEntry = require.resolve("@temporalio/testing");
const testingRequire = createRequire(testingEntry);
const { Worker } = await import(testingRequire.resolve("@temporalio/worker"));

beforeAll(async () => {
  if (HAS_DB) await runMigrations();
});

beforeEach(async () => {
  if (!HAS_DB) return;
  await pool.query(`
    TRUNCATE deletion_restore_tombstone, account_deletion_cleanup_item,
             account_deletion_request, domain_event, users RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  if (HAS_DB) await pool.end();
});

describe.skipIf(!HAS_DB).sequential("account deletion Postgres to Temporal tracer", () => {
  it("dispatches the committed opaque event through main and reaches terminal erasure", async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const user = await apiStore.createUser({ name: "Tracer User", authProvider: "apple" });
    const cipher = createAccountDeletionCipher(
      parseAccountDeletionKeyring({
        activeKeyId: "test",
        keys: { test: Buffer.alloc(32, 12).toString("base64") },
      }),
    );
    const deletions = new PostgresAccountDeletionStore(
      pool,
      new DomainTransactionRunner({ pool }),
      Date.now,
      cipher,
    );
    const receipt = await deletions.request({
      userId: user.id,
      authorizationCode: "tracer-authorization-code",
      appleSubject: "tracer-apple-subject",
    });
    const fence = new PostgresTemporalWorkflowFence(pool);
    const activities = createAccountDeletionActivities({
      store: deletions,
      apple: {
        exchangeAuthorizationCode: vi.fn(async () => ({ refreshToken: "tracer-refresh-token" })),
        revokeRefreshToken: vi.fn(async () => undefined),
      },
      workflows: new TemporalAccountDeletionWorkflowCleanupGateway(environment.client),
      observeErasureStuck: vi.fn(),
      workflowFence: fence,
    });
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: "main",
      workflowsPath,
      activities,
    });
    const dispatcher = new TemporalWorkflowDispatcher(
      registeredTemporalEventHandlers(new TemporalClientWorkflowGateway(environment.client), [
        "AccountDeletionWorkflow",
      ]),
      fence,
    );

    const result = await worker.runUntil(async () => {
      const page = await dispatchOutboxPage({
        outbox: new PostgresOutbox(pool),
        dispatcher,
        owner: "account-deletion-tracer",
        limit: 1,
        now: Date.now(),
        leaseUntil: Date.now() + 30_000,
        retryAt: Date.now() + 60_000,
      });
      const handle = environment.client.workflow.getHandle(`deletion/${receipt.deletionRequestId}`);
      return { page, terminal: await handle.result() };
    });

    expect(result).toEqual({
      page: { claimed: 1, accepted: 1, retried: 0, failed: 0 },
      terminal: "complete",
    });
    await expect(deletions.load(receipt.deletionRequestId)).resolves.toMatchObject({
      state: "complete",
    });
    expect(
      (
        await pool.query("SELECT user_id FROM account_deletion_request WHERE id=$1", [
          receipt.deletionRequestId,
        ])
      ).rows[0],
    ).toEqual({ user_id: null });
    expect((await pool.query("SELECT id FROM users WHERE id=$1", [user.id])).rowCount).toBe(0);
    expect(
      (
        await pool.query("SELECT state FROM domain_event WHERE aggregate_id=$1", [
          receipt.deletionRequestId,
        ])
      ).rowCount,
    ).toBe(0);
    await environment.teardown();
  }, 120_000);
});
