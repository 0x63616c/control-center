import type { ScheduleSpec } from "@www/temporal-runtime";
import {
  DtyeHealthCheckActivity,
  deliverNotification,
  prepareNotification,
  rotatePushTokenBatch,
  suppressNotification,
} from "./activities";

export const WORKFLOW_TYPES = ["DtyeHealthCheckWorkflow", "NotificationDeliveryWorkflow"] as const;
export const MANAGED_SCHEDULE_PREFIX = "dtye_";
export const ACTIVITIES = {
  DtyeHealthCheckActivity,
  prepareNotification,
  deliverNotification,
  suppressNotification,
  rotatePushTokenBatch,
};
export const SCHEDULES = [
  {
    scheduleId: "dtye_health",
    workflowType: "DtyeHealthCheckWorkflow",
    cron: "* * * * *",
    timezone: "UTC",
    args: { iterations: 5 },
    timeout: "2 minutes",
    catchupWindow: "1 minute",
  },
] as const satisfies readonly ScheduleSpec[];
