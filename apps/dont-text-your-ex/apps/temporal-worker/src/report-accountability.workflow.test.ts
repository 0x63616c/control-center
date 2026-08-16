import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReportIdSchema } from "../../../contracts";
import type {
  ReportAccountabilityAction,
  ReportAccountabilityProgress,
  ReportAccountabilityTerminalState,
} from "./report-accountability";

const workflowsPath = new URL("./workflows.ts", import.meta.url).pathname;
const DAY_MS = 86_400_000;

describe.sequential("ReportAccountabilityWorkflow time skipping", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  async function run(
    input: Readonly<{
      reportId: string;
      createdAt: number;
      terminal?: ReportAccountabilityTerminalState;
    }>,
  ) {
    const reportId = ReportIdSchema.parse(input.reportId);
    const actions: ReportAccountabilityAction[] = [];
    const activities = {
      async ReportAccountabilityActivity(activityInput: {
        readonly action: ReportAccountabilityAction;
      }): Promise<ReportAccountabilityProgress> {
        actions.push(activityInput.action);
        if (activityInput.action === "expire") {
          return { state: "expired", reportId, aggregateVersion: 2 };
        }
        if (input.terminal) {
          return { state: input.terminal, reportId, aggregateVersion: 2 };
        }
        return { state: "pending", reportId, aggregateVersion: 1, createdAt: input.createdAt };
      },
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: "main",
      workflowsPath,
      activities,
    });
    const result = await worker.runUntil(() =>
      environment.client.workflow.execute("ReportAccountabilityWorkflow", {
        workflowId: `report/${reportId}`,
        taskQueue: "main",
        args: [{ schemaVersion: 1, reportId }],
      }),
    );
    return { actions, result };
  }

  it("crosses the real 24-hour, 72-hour and seven-day Temporal timers", async () => {
    const createdAt = await environment.currentTimeMs();
    const { actions, result } = await run({
      reportId: "rpt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      createdAt,
    });

    expect(actions).toEqual(["inspect", "remind_immediate", "remind_24h", "remind_72h", "expire"]);
    expect(result).toMatchObject({ state: "expired", aggregateVersion: 2 });
    expect((await environment.currentTimeMs()) - createdAt).toBeGreaterThanOrEqual(7 * DAY_MS);
  });

  it("expires an eight-day-old backfill without replaying reminder stages", async () => {
    const now = await environment.currentTimeMs();
    const { actions, result } = await run({
      reportId: "rpt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      createdAt: now - 8 * DAY_MS,
    });

    expect(actions).toEqual(["inspect", "expire"]);
    expect(result).toMatchObject({ state: "expired" });
  });
});
