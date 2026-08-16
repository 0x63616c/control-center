import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MonthlyRecapPageInput } from "./monthly-recaps";

describe("MonthlyJarRecapWorkflow in Temporal", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  it("runs on main with Temporal time and durably pages a backfill", async () => {
    const calls: MonthlyRecapPageInput[] = [];
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: "main",
      workflowsPath: new URL("./workflows.ts", import.meta.url).pathname,
      activities: {
        MonthlyJarRecapActivity: async (input: MonthlyRecapPageInput) => {
          calls.push(input);
          return calls.length === 1
            ? {
                candidates: 50,
                recaps: 50,
                recipients: 75,
                notifications: 4,
                hasMore: true,
              }
            : {
                candidates: 2,
                recaps: 2,
                recipients: 3,
                notifications: 0,
                hasMore: false,
              };
        },
      },
    });
    const before = await environment.currentTimeMs();
    await environment.sleep("62 days");
    const after = await environment.currentTimeMs();

    const result = await worker.runUntil(
      environment.client.workflow.execute("MonthlyJarRecapWorkflow", {
        workflowId: "recap/2026-07/page_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskQueue: "main",
        args: [{ schemaVersion: 1 }],
      }),
    );

    expect(after - before).toBeGreaterThanOrEqual(62 * 86_400_000);
    expect(result).toEqual({
      candidates: 52,
      recaps: 52,
      recipients: 78,
      notifications: 4,
      runs: 1,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]?.limit).toBe(50);
    expect(calls[0]?.cutoff).toBeGreaterThanOrEqual(after);
    expect((calls[0]?.cutoff ?? 0) - after).toBeLessThan(1_000);
  }, 120_000);
});
