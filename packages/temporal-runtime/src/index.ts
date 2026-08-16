import { type Client, ScheduleAlreadyRunning, ScheduleOverlapPolicy } from "@temporalio/client";
import type { Duration } from "@temporalio/common";
import type { Logger } from "@www/logger";

export interface ScheduleSpec {
  readonly scheduleId: string;
  readonly workflowType: string;
  readonly cron: string;
  readonly timezone?: string;
  readonly args?: unknown;
  readonly timeout?: string;
  readonly catchupWindow?: string;
}

export interface ScheduleGateway {
  upsert(spec: ScheduleSpec, taskQueue: string): Promise<void>;
  listIds(): AsyncIterable<string>;
  delete(scheduleId: string): Promise<void>;
}

export interface ReconcileSchedulesArgs {
  readonly gateway: ScheduleGateway;
  readonly taskQueue: string;
  readonly managedPrefix: string;
  readonly legacyManagedIds?: readonly string[];
  readonly schedules: readonly ScheduleSpec[];
  readonly logger?: Pick<Logger, "info">;
}

export async function reconcileSchedules(args: ReconcileSchedulesArgs): Promise<void> {
  const declared = new Set<string>();
  for (const schedule of args.schedules) {
    if (!schedule.scheduleId.startsWith(args.managedPrefix)) {
      throw new Error(
        `schedule ${schedule.scheduleId} is outside managed prefix ${args.managedPrefix}`,
      );
    }
    if (declared.has(schedule.scheduleId))
      throw new Error(`duplicate schedule ${schedule.scheduleId}`);
    declared.add(schedule.scheduleId);
    await args.gateway.upsert(schedule, args.taskQueue);
    args.logger?.info({ scheduleId: schedule.scheduleId }, "schedule reconciled");
  }

  const legacy = new Set(args.legacyManagedIds ?? []);
  for await (const id of args.gateway.listIds()) {
    const managed = id.startsWith(args.managedPrefix) || legacy.has(id);
    if (!managed || declared.has(id)) continue;
    await args.gateway.delete(id);
    args.logger?.info({ scheduleId: id }, "schedule deleted (managed, no longer declared)");
  }
  args.logger?.info({ declared: declared.size }, "schedules reconciled");
}

const DEFAULT_TIMEZONE = "America/Los_Angeles";
const DEFAULT_CATCHUP_WINDOW: Duration = "1 minute";
const asDuration = (value: string): Duration => value as Duration;

export function temporalScheduleGateway(client: Client): ScheduleGateway {
  return {
    async upsert(schedule, taskQueue) {
      const action = {
        type: "startWorkflow",
        workflowType: schedule.workflowType,
        taskQueue,
        args: schedule.args === undefined ? [] : [schedule.args],
        ...(schedule.timeout === undefined
          ? {}
          : { workflowExecutionTimeout: asDuration(schedule.timeout) }),
      } as const;
      const spec = {
        cronExpressions: [schedule.cron],
        timezone: schedule.timezone ?? DEFAULT_TIMEZONE,
      };
      const policies = {
        overlap: ScheduleOverlapPolicy.SKIP,
        catchupWindow:
          schedule.catchupWindow === undefined
            ? DEFAULT_CATCHUP_WINDOW
            : asDuration(schedule.catchupWindow),
      } as const;
      try {
        await client.schedule.create({ scheduleId: schedule.scheduleId, spec, action, policies });
      } catch (error) {
        if (!(error instanceof ScheduleAlreadyRunning)) throw error;
        await client.schedule.getHandle(schedule.scheduleId).update((previous) => ({
          ...previous,
          spec,
          action: { ...previous.action, ...action },
          policies: { ...previous.policies, ...policies },
        }));
      }
    },
    async *listIds() {
      for await (const summary of client.schedule.list()) yield summary.scheduleId;
    },
    async delete(scheduleId) {
      await client.schedule.getHandle(scheduleId).delete();
    },
  };
}
