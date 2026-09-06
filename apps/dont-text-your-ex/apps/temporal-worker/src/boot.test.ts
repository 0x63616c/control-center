import type { ScheduleGateway } from "@www/temporal-runtime";
import { describe, expect, test, vi } from "vitest";
import { prepareTemporalWorker } from "./boot";

describe("DTYE Temporal boot wiring", () => {
  test("passes the same exact main queue to schedules and worker creation", async () => {
    const scheduleQueues: string[] = [];
    const gateway: ScheduleGateway = {
      async upsert(_schedule, taskQueue) {
        scheduleQueues.push(taskQueue);
      },
      async *listIds() {},
      async delete() {},
    };
    const createWorker = vi.fn(async () => ({ worker: "ready" as const }));

    await expect(
      prepareTemporalWorker({
        config: { namespace: "dont-text-your-ex", taskQueue: "main" },
        scheduleGateway: gateway,
        createWorker,
      }),
    ).resolves.toEqual({ worker: "ready" });

    expect(scheduleQueues).toEqual(["main", "main", "main", "main", "main"]);
    expect(createWorker).toHaveBeenCalledWith({
      namespace: "dont-text-your-ex",
      taskQueue: "main",
    });
  });
});
