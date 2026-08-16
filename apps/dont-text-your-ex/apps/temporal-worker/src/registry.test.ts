import { describe, expect, test } from "vitest";
import { ACTIVITIES, MANAGED_SCHEDULE_PREFIX, SCHEDULES, WORKFLOW_TYPES } from "./registry";
import * as workflows from "./workflows";

describe("DTYE Temporal registry", () => {
  test("registers health and notification delivery on the main queue contract", () => {
    expect(WORKFLOW_TYPES).toEqual(["DtyeHealthCheckWorkflow", "NotificationDeliveryWorkflow"]);
    expect(Object.keys(workflows)).toContain("DtyeHealthCheckWorkflow");
    expect(Object.keys(workflows)).toContain("NotificationDeliveryWorkflow");
    expect(Object.keys(ACTIVITIES)).toEqual([
      "DtyeHealthCheckActivity",
      "prepareNotification",
      "deliverNotification",
      "suppressNotification",
      "rotatePushTokenBatch",
    ]);
    expect(MANAGED_SCHEDULE_PREFIX).toBe("dtye_");
    expect(SCHEDULES).toEqual([
      {
        scheduleId: "dtye_health",
        workflowType: "DtyeHealthCheckWorkflow",
        cron: "* * * * *",
        timezone: "UTC",
        args: { iterations: 5 },
        timeout: "2 minutes",
        catchupWindow: "1 minute",
      },
    ]);
  });
});
