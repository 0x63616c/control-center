import { describe, expect, test } from "vitest";
import { reconcileSchedules, type ScheduleGateway, type ScheduleSpec } from "../src/index";

const declared: readonly ScheduleSpec[] = [
  {
    scheduleId: "dtye_health",
    workflowType: "DtyeHealthCheckWorkflow",
    cron: "* * * * *",
    args: { iterations: 1 },
    timeout: "2 minutes",
    catchupWindow: "1 minute",
  },
];

function fake(existing: readonly string[]) {
  const events: string[] = [];
  const gateway: ScheduleGateway = {
    async upsert(spec, taskQueue) {
      events.push(`upsert:${spec.scheduleId}:${taskQueue}`);
    },
    async *listIds() {
      yield* existing;
    },
    async delete(id) {
      events.push(`delete:${id}`);
    },
  };
  return { events, gateway };
}

describe("reconcileSchedules", () => {
  test("converges its own prefix without deleting another product or unmanaged schedules", async () => {
    const { events, gateway } = fake(["dtye_removed", "app_weather_purge", "manual"]);
    await reconcileSchedules({
      gateway,
      taskQueue: "main",
      managedPrefix: "dtye_",
      schedules: declared,
    });
    expect(events).toEqual(["upsert:dtye_health:main", "delete:dtye_removed"]);
  });

  test("rejects a declaration outside the registry's managed prefix", async () => {
    const { gateway } = fake([]);
    await expect(
      reconcileSchedules({
        gateway,
        taskQueue: "main",
        managedPrefix: "dtye_",
        schedules: [{ ...declared[0], scheduleId: "manual" }],
      }),
    ).rejects.toThrow(/managed prefix/);
  });
});
