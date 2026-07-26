/**
 * The `health-check` Schedule, upserted every time a worker boots.
 *
 * Upsert-on-boot (rather than a one-shot job) is what makes the schedule part of
 * the deploy: roll the worker and the schedule matches the code that shipped
 * with it. It has to be genuinely idempotent — two replicas boot at once, and
 * every deploy runs it again — so "already exists" is a normal outcome that
 * updates the existing schedule in place rather than an error.
 */
import { type Client, ScheduleAlreadyRunning, ScheduleOverlapPolicy } from "@temporalio/client";
import type { Logger } from "@www/logger";
import { HEALTH_CHECK_SCHEDULE_ID, HEALTH_CHECK_WORKFLOW_TYPE } from "./config";
import type { HealthCheckWorkflowInput } from "./workflows";

/** Once a minute, on the minute. */
const HEALTH_CHECK_CRON = "* * * * *";

export interface UpsertHealthCheckScheduleArgs {
  readonly client: Client;
  readonly taskQueue: string;
  readonly iterations: number;
  readonly logger: Logger;
}

/**
 * @public - called once per worker boot from index.ts.
 */
export async function upsertHealthCheckSchedule(
  args: UpsertHealthCheckScheduleArgs,
): Promise<void> {
  const { client, taskQueue, iterations, logger } = args;
  const input: HealthCheckWorkflowInput = { iterations };

  const action = {
    type: "startWorkflow",
    workflowType: HEALTH_CHECK_WORKFLOW_TYPE,
    taskQueue,
    args: [input],
    // The run spends the whole minute pacing its N checks, so a run that is
    // still going when the next one is due means something is genuinely wedged.
    // Skip rather than queue: a backlog of health checks tells you nothing that
    // the missed-run gap in history doesn't already.
    workflowExecutionTimeout: "2 minutes",
  } as const;

  const spec = { cronExpressions: [HEALTH_CHECK_CRON] };
  const policies = { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: "1 minute" } as const;

  try {
    await client.schedule.create({
      scheduleId: HEALTH_CHECK_SCHEDULE_ID,
      spec,
      action,
      policies,
    });
    logger.info(
      { scheduleId: HEALTH_CHECK_SCHEDULE_ID, taskQueue },
      "health-check schedule created",
    );
    return;
  } catch (error) {
    if (!(error instanceof ScheduleAlreadyRunning)) throw error;
  }

  // Already there from an earlier boot: rewrite it so the schedule always
  // reflects THIS deploy's cron/args, never a stale one.
  const handle = client.schedule.getHandle(HEALTH_CHECK_SCHEDULE_ID);
  await handle.update((previous) => ({
    ...previous,
    spec,
    action: { ...previous.action, ...action },
    policies: { ...previous.policies, ...policies },
  }));
  logger.info({ scheduleId: HEALTH_CHECK_SCHEDULE_ID, taskQueue }, "health-check schedule updated");
}
