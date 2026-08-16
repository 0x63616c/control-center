import type { ScheduleSpec } from "@www/temporal-runtime";
import { DtyeHealthCheckActivity, deliverNotification, prepareNotification } from "./activities";

export const WORKFLOW_TYPES = [
  "DtyeHealthCheckWorkflow",
  "OutboxDispatchRecoveryWorkflow",
  "SessionMaintenanceWorkflow",
  "NotificationDeliveryWorkflow",
] as const;
export const MANAGED_SCHEDULE_PREFIX = "dtye_";
export const ACTIVITY_TYPES = [
  "DtyeHealthCheckActivity",
  "OutboxDispatchActivity",
  "SessionMaintenanceActivity",
  "prepareNotification",
  "deliverNotification",
] as const;
export const ACTIVITIES = { DtyeHealthCheckActivity, prepareNotification, deliverNotification };
export const SCHEDULES = [
  {
    scheduleId: "dtye_health",
    workflowType: "DtyeHealthCheckWorkflow",
    cron: "* * * * *",
    timezone: "UTC",
    args: { schemaVersion: 1 },
    timeout: "2 minutes",
    catchupWindow: "1 minute",
  },
  {
    scheduleId: "dtye_outbox_recovery",
    workflowType: "OutboxDispatchRecoveryWorkflow",
    cron: "* * * * *",
    timezone: "UTC",
    args: { schemaVersion: 1 },
    timeout: "5 minutes",
    catchupWindow: "1 minute",
  },
  {
    scheduleId: "dtye_session_maintenance",
    workflowType: "SessionMaintenanceWorkflow",
    cron: "17 3 * * *",
    timezone: "UTC",
    args: { schemaVersion: 1 },
    timeout: "10 minutes",
    catchupWindow: "1 minute",
  },
] as const satisfies readonly ScheduleSpec[];
