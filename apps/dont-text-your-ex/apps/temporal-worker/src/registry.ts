import type { ScheduleSpec } from "@www/temporal-runtime";
export const WORKFLOW_TYPES = [
  "DtyeHealthCheckWorkflow",
  "OutboxDispatchRecoveryWorkflow",
  "SessionMaintenanceWorkflow",
] as const;
export const MANAGED_SCHEDULE_PREFIX = "dtye_";
export const ACTIVITY_TYPES = [
  "DtyeHealthCheckActivity",
  "OutboxDispatchActivity",
  "SessionMaintenanceActivity",
] as const;
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
    cron: "17 * * * *",
    timezone: "UTC",
    args: { schemaVersion: 1 },
    timeout: "10 minutes",
    catchupWindow: "1 minute",
  },
] as const satisfies readonly ScheduleSpec[];
