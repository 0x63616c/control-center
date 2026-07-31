/**
 * Boot-time Schedule reconciliation (ADR-0008): the declarative counterpart of
 * the old hardcoded health-check upsert. Every deploy makes Temporal match
 * `features/_generated/schedules.gen.ts` exactly:
 *
 *  - every declared schedule is UPSERTED (create, or update-in-place on
 *    ScheduleAlreadyRunning), so a rolled worker always ships its facet's
 *    cron/args — never a stale one;
 *  - every schedule this system MANAGES (ID prefix `app_`, plus the legacy
 *    pre-facet IDs below) that is no longer declared is DELETED. Declarative
 *    means removal works like addition: drop the facet entry, deploy, gone.
 *
 * Idempotent by construction — two replicas booting at once, or every deploy
 * re-running it, converge on the same state. Runs BEFORE worker.run(): if the
 * schedule set cannot be written the deploy should fail loudly here, not come
 * up green with nothing ever being scheduled.
 */
import { type Client, ScheduleAlreadyRunning, ScheduleOverlapPolicy } from "@temporalio/client";
import type { Duration } from "@temporalio/common";
import type { Logger } from "@www/logger";
import type { GeneratedSchedule } from "../../../features/_generated/schedules.gen";

/** Every schedule ID the facet system owns starts with this (see collect()). */
const MANAGED_PREFIX = "app_";

/**
 * Schedule IDs created by this worker BEFORE the facet system existed. They
 * don't carry the managed prefix, so the sweep below must name them explicitly
 * or the old `health-check` schedule would fire forever alongside its
 * facet-owned replacement.
 */
const LEGACY_SCHEDULE_IDS: readonly string[] = ["health-check"];

const DEFAULT_TIMEZONE = "America/Los_Angeles";
const DEFAULT_CATCHUP_WINDOW: Duration = "1 minute";

/**
 * Generated schedules carry ms-style duration strings ("30 minutes") but are
 * typed as plain `string` in schedules.gen.ts; Temporal's Duration is the
 * ms template-literal union, so plain string no longer assigns now that
 * real `@types/ms` typings are in the tree. The apps-gen validator is the
 * owner of the format; this cast just records that contract for TS.
 */
function asDuration(value: string): Duration {
  return value as Duration;
}

export interface ReconcileSchedulesArgs {
  readonly client: Client;
  readonly taskQueue: string;
  readonly schedules: readonly GeneratedSchedule[];
  readonly logger: Logger;
}

/**
 * @public - called once per worker boot from index.ts.
 */
export async function reconcileSchedules(args: ReconcileSchedulesArgs): Promise<void> {
  const { client, taskQueue, schedules, logger } = args;

  for (const s of schedules) {
    const action = {
      type: "startWorkflow",
      workflowType: s.workflowType,
      taskQueue,
      args: s.argsJson === undefined ? [] : [JSON.parse(s.argsJson) as unknown],
      ...(s.timeout === undefined ? {} : { workflowExecutionTimeout: asDuration(s.timeout) }),
    } as const;
    const spec = {
      cronExpressions: [s.cron],
      timezone: s.timezone ?? DEFAULT_TIMEZONE,
    };
    const policies = {
      // SKIP, always: these are cron-shaped runs; a backlog of catch-up
      // executions tells you nothing the missed-run gap in history doesn't.
      overlap: ScheduleOverlapPolicy.SKIP,
      catchupWindow:
        s.catchupWindow === undefined ? DEFAULT_CATCHUP_WINDOW : asDuration(s.catchupWindow),
    } as const;

    try {
      await client.schedule.create({ scheduleId: s.scheduleId, spec, action, policies });
      logger.info({ scheduleId: s.scheduleId, source: s.source }, "schedule created");
    } catch (error) {
      if (!(error instanceof ScheduleAlreadyRunning)) throw error;
      const handle = client.schedule.getHandle(s.scheduleId);
      await handle.update((previous) => ({
        ...previous,
        spec,
        action: { ...previous.action, ...action },
        policies: { ...previous.policies, ...policies },
      }));
      logger.info({ scheduleId: s.scheduleId, source: s.source }, "schedule updated");
    }
  }

  // Sweep: delete managed schedules that are no longer declared.
  const declared = new Set(schedules.map((s) => s.scheduleId));
  for await (const summary of client.schedule.list()) {
    const id = summary.scheduleId;
    const managed = id.startsWith(MANAGED_PREFIX) || LEGACY_SCHEDULE_IDS.includes(id);
    if (!managed || declared.has(id)) continue;
    await client.schedule.getHandle(id).delete();
    logger.info({ scheduleId: id }, "schedule deleted (managed, no longer declared)");
  }

  logger.info({ declared: declared.size }, "schedules reconciled");
}
