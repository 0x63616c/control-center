/**
 * Every knob this runtime reads, projected from the ONE env manifest
 * (`@www/platform/env`). Nothing here touches `process.env` directly — that is
 * the rule the whole repo enforces, after an import-order bug froze feature
 * config at pre-hydration defaults in prod.
 */
import { ENV } from "@www/platform/env";

/** Names shared with the infra program — they must agree or nothing connects. */
export const HEALTH_CHECK_SCHEDULE_ID = "health-check";

/**
 * The workflow type name the Schedule starts. Deliberately a LITERAL, not
 * `HealthCheckWorkflow.name`: importing workflows.ts here would drag
 * `@temporalio/workflow` into the main thread, outside the determinism sandbox
 * it expects to live in. `workflow-names.test.ts` asserts the literal still
 * matches the function actually exported by workflows.ts.
 */
export const HEALTH_CHECK_WORKFLOW_TYPE = "HealthCheckWorkflow";

export interface TemporalWorkerConfig {
  readonly address: string;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly healthCheckIterations: number;
}

/** @public - read once at boot in index.ts. */
export function temporalWorkerConfig(): TemporalWorkerConfig {
  const env = ENV.pick(
    "TEMPORAL_ADDRESS",
    "TEMPORAL_NAMESPACE",
    "TEMPORAL_TASK_QUEUE",
    "TEMPORAL_HEALTH_CHECK_ITERATIONS",
  );
  return {
    address: env.TEMPORAL_ADDRESS,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue: env.TEMPORAL_TASK_QUEUE,
    healthCheckIterations: env.TEMPORAL_HEALTH_CHECK_ITERATIONS,
  };
}
