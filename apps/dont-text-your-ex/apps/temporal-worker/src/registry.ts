import type { ScheduleSpec } from "@www/temporal-runtime";
import * as activities from "./activities";

export const WORKFLOW_TYPES = ["DtyeHealthCheckWorkflow"] as const;
export const MANAGED_SCHEDULE_PREFIX = "dtye_";
export const ACTIVITIES = activities;
export const SCHEDULES = [
  {
    scheduleId: "dtye_health",
    workflowType: "DtyeHealthCheckWorkflow",
    cron: "* * * * *",
    args: { iterations: 5 },
    timeout: "2 minutes",
    catchupWindow: "1 minute",
  },
] as const satisfies readonly ScheduleSpec[];
