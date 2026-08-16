import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NotificationIdSchema,
  ReportIdSchema,
  RescueInterventionIdSchema,
} from "../../../contracts";
import { InviteVersionIdSchema } from "../../api/src/domain-events";
import { WORKFLOW_TYPES } from "./registry";

const workflowsPath = new URL("./workflows.ts", import.meta.url).pathname;
const require = createRequire(import.meta.url);
const testingEntry = require.resolve("@temporalio/testing");
const testingRequire = createRequire(testingEntry);
const workerEntry = testingRequire.resolve("@temporalio/worker");
const { Worker } = await import(workerEntry);
const workerRequire = createRequire(workerEntry);
const temporalProto = await import(workerRequire.resolve("@temporalio/proto"));
const HistoryProto = temporalProto.temporal.api.history.v1.History;

const notificationId = NotificationIdSchema.parse("ntf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const reportId = ReportIdSchema.parse("rpt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const interventionId = RescueInterventionIdSchema.parse("rsi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const inviteVersionId = InviteVersionIdSchema.parse("inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

const REPLAY_FIXTURES = [
  {
    workflowType: "DtyeHealthCheckWorkflow",
    workflowId: "replay/dtye-health",
    input: { schemaVersion: 1 },
  },
  {
    workflowType: "OutboxDispatchRecoveryWorkflow",
    workflowId: "replay/outbox-recovery",
    input: { schemaVersion: 1 },
  },
  {
    workflowType: "SessionMaintenanceWorkflow",
    workflowId: "replay/session-maintenance",
    input: { schemaVersion: 1 },
  },
  {
    workflowType: "NotificationDeliveryWorkflow",
    workflowId: `replay/notification/${notificationId}`,
    input: { schemaVersion: 1, notificationId },
  },
  {
    workflowType: "ReportAccountabilityWorkflow",
    workflowId: `replay/report/${reportId}`,
    input: { schemaVersion: 1, reportId },
  },
  {
    workflowType: "UrgeRescueWorkflow",
    workflowId: `replay/rescue/${interventionId}`,
    input: { schemaVersion: 1, interventionId },
  },
  {
    workflowType: "StreakMilestoneSweepWorkflow",
    workflowId: "replay/streak-sweep",
    input: { schemaVersion: 1 },
  },
  {
    workflowType: "InviteLifecycleWorkflow",
    workflowId: `replay/invite/${inviteVersionId}`,
    input: { schemaVersion: 1, inviteVersionId },
  },
] as const;

function retainedHistoryPath(workflowType: (typeof REPLAY_FIXTURES)[number]["workflowType"]): URL {
  return new URL(`./replay-fixtures/${workflowType}.json`, import.meta.url);
}

function sanitizeHistoryIdentity(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key === "identity" && typeof child === "string") {
      record[key] = "fixture-worker";
    } else {
      sanitizeHistoryIdentity(child);
    }
  }
}

function serializeRetainedHistory(history: unknown): string {
  return JSON.stringify(
    {
      encoding: "temporal-history-protobuf-base64",
      history: Buffer.from(HistoryProto.encode(history).finish()).toString("base64"),
    },
    null,
    2,
  );
}

function parseRetainedHistory(serialized: string): unknown {
  const fixture = JSON.parse(serialized) as { encoding?: unknown; history?: unknown };
  if (
    fixture.encoding !== "temporal-history-protobuf-base64" ||
    typeof fixture.history !== "string"
  ) {
    throw new Error("invalid retained Temporal history fixture");
  }
  return HistoryProto.decode(Buffer.from(fixture.history, "base64"));
}

describe.sequential("DTYE workflow replay compatibility", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  it("keeps a sanitized replay fixture for every registered workflow type", async () => {
    expect(REPLAY_FIXTURES.map((fixture) => fixture.workflowType)).toEqual(WORKFLOW_TYPES);

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: "main",
      workflowsPath,
      activities: {
        DtyeHealthCheckActivity: async () => ({ ok: true as const }),
        OutboxDispatchActivity: async () => ({
          claimed: 0,
          accepted: 0,
          retried: 0,
          failed: 0,
        }),
        SessionMaintenanceActivity: async () => ({ deleted: 0 }),
        prepareNotification: async () => ({ deliveryIds: [] }),
        deliverNotification: async () => ({ kind: "accepted" as const }),
        suppressNotification: async () => ({ suppressed: 0 }),
        ReportAccountabilityActivity: async () => ({
          state: "denied" as const,
          reportId,
          aggregateVersion: 1,
        }),
        loadRescue: async () => null,
        advanceRescueAtDeadline: async () => null,
        eraseRescueForAccountDeletion: async () => ({ erased: true as const }),
        StreakMilestoneSweepActivity: async () => ({
          candidates: 0,
          achievements: 0,
          notifications: 0,
          sharedActivities: 0,
          hasMore: false,
        }),
        loadInviteLifecycle: async () => ({ kind: "superseded" as const }),
        requestInviteReminder: async () => ({ kind: "superseded" as const }),
      },
    });

    const histories = await worker.runUntil(async () => {
      const captured = [];
      for (const fixture of REPLAY_FIXTURES) {
        const handle = await environment.client.workflow.start(fixture.workflowType, {
          workflowId: fixture.workflowId,
          workflowIdReusePolicy: "REJECT_DUPLICATE",
          taskQueue: "main",
          args: [fixture.input],
        });
        await handle.result();
        captured.push({ fixture, history: await handle.fetchHistory() });
      }
      return captured;
    });

    for (const { fixture, history } of histories) {
      const path = retainedHistoryPath(fixture.workflowType);
      // biome-ignore lint/style/noProcessEnv: test-only maintainer flag for explicitly regenerating checked-in fixtures.
      if (process.env.UPDATE_DTYE_REPLAY_FIXTURES === "1") {
        mkdirSync(dirname(path.pathname), { recursive: true });
        sanitizeHistoryIdentity(history);
        writeFileSync(path, `${serializeRetainedHistory(history)}\n`);
      }
      const serialized = readFileSync(path, "utf8");
      const decoded = parseRetainedHistory(serialized);
      const sanitizedView = JSON.stringify(decoded);
      expect(sanitizedView).not.toMatch(
        /bearer|device[_-]?token|invite[_-]?code|apple[_-]?token|\.local|calum/i,
      );
      expect(sanitizedView).not.toMatch(/https?:\/\//i);
      await Worker.runReplayHistory({ workflowsPath }, decoded, fixture.workflowId);
    }
  }, 120_000);
});
