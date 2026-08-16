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
    let handle: Awaited<ReturnType<typeof environment.client.workflow.start>> | undefined;
    const result = await worker.runUntil(async () => {
      handle = await environment.client.workflow.start("ReportAccountabilityWorkflow", {
        workflowId: `report/${reportId}`,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        taskQueue: "main",
        args: [{ schemaVersion: 1, reportId }],
      });
      return handle.result();
    });
    return { actions, result, history: await handle?.fetchHistory() };
  }

  it("crosses the real 24-hour, 72-hour and seven-day Temporal timers", async () => {
    const createdAt = await environment.currentTimeMs();
    const { actions, result, history } = await run({
      reportId: "rpt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      createdAt,
    });

    expect(actions).toEqual(["inspect", "remind_immediate", "remind_24h", "remind_72h", "expire"]);
    expect(result).toMatchObject({ state: "expired", aggregateVersion: 2 });
    expect((await environment.currentTimeMs()) - createdAt).toBeGreaterThanOrEqual(7 * DAY_MS);
    await Worker.runReplayHistory({ workflowsPath }, history);
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

  it.each([
    ["denied", "denied", "rpt_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
    ["jarClosed", "jar_closed", "rpt_ffffffffffffffffffffffffffffffff"],
    ["memberDeparted", "member_departed", "rpt_11111111111111111111111111111110"],
    ["accountDeleted", "account_deleted", "rpt_22222222222222222222222222222220"],
  ] as const)("ends from the authoritative %s signal", async (signalName, terminalState, rawId) => {
    const reportId = ReportIdSchema.parse(rawId);
    const createdAt = await environment.currentTimeMs();
    let terminal: ReportAccountabilityTerminalState | undefined;
    const actions: ReportAccountabilityAction[] = [];
    let markReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: "main",
      workflowsPath,
      activities: {
        async ReportAccountabilityActivity(input: {
          readonly action: ReportAccountabilityAction;
        }): Promise<ReportAccountabilityProgress> {
          actions.push(input.action);
          if (input.action === "remind_immediate") markReady?.();
          if (terminal) return { state: terminal, reportId, aggregateVersion: 2 };
          return { state: "pending", reportId, aggregateVersion: 1, createdAt };
        },
      },
    });
    const result = await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("ReportAccountabilityWorkflow", {
        workflowId: `report/${reportId}`,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        taskQueue: "main",
        args: [{ schemaVersion: 1, reportId }],
      });
      await ready;
      terminal = terminalState;
      const signal = { schemaVersion: 1 as const, reportId, expectedAggregateVersion: 2 };
      await handle.signal(signalName, signal);
      await handle.signal(signalName, signal);
      return handle.result();
    });

    expect(result).toMatchObject({ state: terminalState });
    expect(actions).toEqual(["inspect", "remind_immediate", "inspect"]);
  });
});
