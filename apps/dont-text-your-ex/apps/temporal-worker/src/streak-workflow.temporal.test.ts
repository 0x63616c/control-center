import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StreakSweepPageInput } from "./streak-milestones";

describe("StreakMilestoneSweepWorkflow in Temporal", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  it("runs on main and takes its stable cutoff from Temporal time after a large skip", async () => {
    const calls: StreakSweepPageInput[] = [];
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: "main",
      workflowsPath: new URL("./workflows.ts", import.meta.url).pathname,
      activities: {
        StreakMilestoneSweepActivity: async (input: StreakSweepPageInput) => {
          calls.push(input);
          return {
            candidates: 0,
            achievements: 0,
            notifications: 0,
            sharedActivities: 0,
            hasMore: false,
          };
        },
      },
    });
    const before = await environment.currentTimeMs();
    await environment.sleep("200 days");
    const after = await environment.currentTimeMs();

    const result = await worker.runUntil(
      environment.client.workflow.execute("StreakMilestoneSweepWorkflow", {
        workflowId: "streak-time-skipping-proof",
        taskQueue: "main",
        args: [{ schemaVersion: 1 }],
      }),
    );

    expect(after - before).toBeGreaterThanOrEqual(200 * 86_400_000);
    expect(after - before).toBeLessThan(200 * 86_400_000 + 1_000);
    expect(result).toEqual({
      candidates: 0,
      achievements: 0,
      notifications: 0,
      sharedActivities: 0,
      runs: 1,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.limit).toBe(100);
    expect(calls[0]?.cutoff).toBeGreaterThanOrEqual(after);
    expect((calls[0]?.cutoff ?? 0) - after).toBeLessThan(1_000);
  }, 120_000);
});
