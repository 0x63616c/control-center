/**
 * Activity implementations for the `main` task queue.
 *
 * Convention (locked by the originating ask): every workflow AND every activity
 * takes exactly ONE argument and returns exactly ONE value. Adding a parameter
 * is therefore always a field on the input object, never a second positional —
 * which is also what keeps Temporal's payload versioning tractable.
 */
import { hostname } from "node:os";

/** Sole argument of {@link HealthCheckActivity}. */
export interface HealthCheckActivityInput {
  /** 0-based index of this check within its workflow run. */
  readonly iteration: number;
}

/** Sole return value of {@link HealthCheckActivity}. */
export interface HealthCheckActivityOutput {
  readonly iteration: number;
  /** Wall-clock instant the activity ran, ISO-8601. */
  readonly observedAt: string;
  /** Pod hostname that served it — proves WHICH worker replica answered. */
  readonly workerHost: string;
}

/**
 * The cheapest possible activity: it returns immediately. Its only job is to
 * prove the whole round trip is alive — worker polling the `main` task queue,
 * frontend dispatching, history persisting the completion. Anything that could
 * block (network, disk) would make a red health check ambiguous.
 *
 * @public - registered on the worker in index.ts, called by HealthCheckWorkflow.
 */
export async function HealthCheckActivity(
  input: HealthCheckActivityInput,
): Promise<HealthCheckActivityOutput> {
  return {
    iteration: input.iteration,
    observedAt: new Date().toISOString(),
    workerHost: hostname(),
  };
}
