import type { Logger } from "@www/logger";
import { reconcileSchedules, type ScheduleGateway } from "@www/temporal-runtime";
import { MANAGED_SCHEDULE_PREFIX, SCHEDULES } from "./registry";

export interface DtyeTemporalWorkerIdentity {
  readonly namespace: "dont-text-your-ex";
  readonly taskQueue: "main";
}

export async function prepareTemporalWorker<Worker>(dependencies: {
  readonly config: DtyeTemporalWorkerIdentity;
  readonly scheduleGateway: ScheduleGateway;
  readonly createWorker: (identity: DtyeTemporalWorkerIdentity) => Promise<Worker>;
  readonly logger?: Pick<Logger, "info">;
}): Promise<Worker> {
  await reconcileSchedules({
    gateway: dependencies.scheduleGateway,
    taskQueue: dependencies.config.taskQueue,
    managedPrefix: MANAGED_SCHEDULE_PREFIX,
    schedules: SCHEDULES,
    logger: dependencies.logger,
  });
  return dependencies.createWorker({
    namespace: dependencies.config.namespace,
    taskQueue: dependencies.config.taskQueue,
  });
}
