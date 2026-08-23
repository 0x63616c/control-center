import { describe, expect, test } from "vitest";
import { ACTIVITY_TYPES, MANAGED_SCHEDULE_PREFIX, SCHEDULES, WORKFLOW_TYPES } from "./registry";
import * as workflows from "./workflows";

describe("DTYE Temporal registry", () => {
  test("registers all implemented workflows and activities on the main queue contract", () => {
    expect(WORKFLOW_TYPES).toEqual([
      "DtyeHealthCheckWorkflow",
      "OutboxDispatchRecoveryWorkflow",
      "SessionMaintenanceWorkflow",
      "NotificationDeliveryWorkflow",
      "ReportAccountabilityWorkflow",
      "UrgeRescueWorkflow",
      "StreakMilestoneSweepWorkflow",
      "InviteLifecycleWorkflow",
      "AccountDeletionWorkflow",
      "AccountDeletionHistorySweepWorkflow",
    ]);
    expect(Object.keys(workflows)).toContain("DtyeHealthCheckWorkflow");
    expect(Object.keys(workflows)).toContain("NotificationDeliveryWorkflow");
    expect(Object.keys(workflows)).toContain("ReportAccountabilityWorkflow");
    expect(Object.keys(workflows)).toContain("UrgeRescueWorkflow");
    expect(Object.keys(workflows)).toContain("StreakMilestoneSweepWorkflow");
    expect(Object.keys(workflows)).toContain("InviteLifecycleWorkflow");
    expect(Object.keys(workflows)).toContain("AccountDeletionWorkflow");
    expect(Object.keys(workflows)).toContain("AccountDeletionHistorySweepWorkflow");
    expect(ACTIVITY_TYPES).toEqual([
      "DtyeHealthCheckActivity",
      "OutboxDispatchActivity",
      "SessionMaintenanceActivity",
      "prepareNotification",
      "deliverNotification",
      "suppressNotification",
      "rotatePushTokenBatch",
      "ReportAccountabilityActivity",
      "loadRescue",
      "advanceRescueAtDeadline",
      "eraseRescueForAccountDeletion",
      "StreakMilestoneSweepActivity",
      "loadInviteLifecycle",
      "requestInviteReminder",
      "eraseAccountLocally",
      "revokeAppleCredential",
      "finishAccountDeletion",
      "terminateAssociatedWorkflows",
      "deleteAssociatedWorkflowHistories",
      "sweepAccountDeletionHistories",
      "purgeExpiredAccountDeletionRecords",
      "recordAccountDeletionErasureStuck",
    ]);
    expect(MANAGED_SCHEDULE_PREFIX).toBe("dtye_");
    expect(SCHEDULES).toEqual([
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
        scheduleId: "dtye_streak_sweep",
        workflowType: "StreakMilestoneSweepWorkflow",
        cron: "0 * * * *",
        timezone: "UTC",
        args: { schemaVersion: 1 },
        timeout: "10 minutes",
        catchupWindow: "1 minute",
      },
      {
        scheduleId: "dtye_account_deletion_history_sweep",
        workflowType: "AccountDeletionHistorySweepWorkflow",
        cron: "23 * * * *",
        timezone: "UTC",
        args: { schemaVersion: 1 },
        timeout: "10 minutes",
        catchupWindow: "1 hour",
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
    ]);
  });
});
