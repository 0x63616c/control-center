import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MonthlyRecapPageInput, PrepareMonthlyRecapPagesInput } from "./monthly-recaps";

describe("MonthlyJarRecapScheduleWorkflow in Temporal", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  it("runs on main and starts a stable, privacy-safe child that durably pages", async () => {
    const pageId = "rpg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
    const pageCalls: MonthlyRecapPageInput[] = [];
    const preparationCalls: PrepareMonthlyRecapPagesInput[] = [];
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: "main",
      workflowsPath: new URL("./workflows.ts", import.meta.url).pathname,
      activities: {
        PrepareMonthlyRecapPagesActivity: async (input: PrepareMonthlyRecapPagesInput) => {
          preparationCalls.push(input);
          return [{ calendarMonth: "2026-07" as const, pageId }];
        },
        MonthlyJarRecapActivity: async (input: MonthlyRecapPageInput) => {
          pageCalls.push(input);
          return {
            candidates: pageCalls.length === 1 ? 50 : 2,
            recaps: pageCalls.length === 1 ? 50 : 2,
            recipients: pageCalls.length === 1 ? 75 : 3,
            notifications: pageCalls.length === 1 ? 4 : 0,
            hasMore: pageCalls.length === 1,
          };
        },
      },
    });
    const before = await environment.currentTimeMs();
    await environment.sleep("62 days");
    const after = await environment.currentTimeMs();

    const result = await worker.runUntil(
      environment.client.workflow.execute("MonthlyJarRecapScheduleWorkflow", {
        workflowId: "monthly-recap-schedule-proof",
        taskQueue: "main",
        args: [{ schemaVersion: 1 }],
      }),
    );

    expect(after - before).toBeGreaterThanOrEqual(62 * 86_400_000);
    expect(result).toEqual({ schemaVersion: 1 });
    expect(preparationCalls).toHaveLength(1);
    expect(preparationCalls[0]?.limit).toBe(24);
    expect(preparationCalls[0]?.cutoff).toBeGreaterThanOrEqual(after);
    expect((preparationCalls[0]?.cutoff ?? 0) - after).toBeLessThan(1_000);
    expect(pageCalls).toEqual([
      { pageId, limit: 50 },
      { pageId, limit: 50 },
    ]);
    const child = await environment.client.workflow.getHandle(`recap/2026-07/${pageId}`).describe();
    expect(child.status.name).toBe("COMPLETED");
  }, 120_000);
});
