/**
 * Workflow definitions for the `main` task queue.
 *
 * This file is NOT bundled by our Dockerfile. The Worker hands it to the SDK's
 * own webpack+swc pipeline at boot (`workflowsPath`), which is what enforces the
 * determinism sandbox — so it may only import `@temporalio/workflow` and pure
 * local modules. No logger, no `node:*`, no I/O: anything with a side effect
 * belongs in activities.ts.
 */
import { proxyActivities, sleep } from "@temporalio/workflow";
import type * as activities from "./activities";
import type { HealthCheckActivityOutput } from "./activities";
import { HEALTH_CHECK_PERIOD_MS, healthCheckSleepMs } from "./pacing";

/** Sole argument of {@link HealthCheckWorkflow}. */
export interface HealthCheckWorkflowInput {
  /** `N`: how many activities to fire, evenly spread across `periodMs`. */
  readonly iterations: number;
  /** Budget to spread them across. Defaults to the one-minute cron period. */
  readonly periodMs?: number;
}

/** Sole return value of {@link HealthCheckWorkflow}. */
export interface HealthCheckWorkflowOutput {
  readonly iterations: number;
  /** One entry per activity, in fire order. */
  readonly checks: readonly HealthCheckActivityOutput[];
  /** How long the whole run took, per the workflow's own (replay-safe) clock. */
  readonly elapsedMs: number;
}

// startToCloseTimeout is deliberately far below one slot (12s at N=5): the
// activity returns immediately, so anything slower is already a failure worth
// surfacing rather than absorbing. Retries are capped because a health check
// that needs three attempts should show up as a slow/failed run, not be papered
// over — the next cron run is only a minute away.
const { HealthCheckActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 seconds",
  retry: { maximumAttempts: 2 },
});

/**
 * Fires `input.iterations` health-check activities evenly across the period,
 * each one scheduled against an ABSOLUTE deadline (`i * period/N` from start)
 * so activity latency is absorbed by its own slot instead of accumulating. See
 * pacing.ts for the maths and its tests.
 *
 * Registered as a once-a-minute cron Schedule, upserted by the worker at boot
 * (schedule.ts) — so a green run of THIS workflow is the end-to-end liveness
 * proof for the whole stack: server, Postgres, task queue, and worker.
 *
 * @public - the workflow type name is exactly `HealthCheckWorkflow`.
 */
export async function HealthCheckWorkflow(
  input: HealthCheckWorkflowInput,
): Promise<HealthCheckWorkflowOutput> {
  const iterations = input.iterations;
  const periodMs = input.periodMs ?? HEALTH_CHECK_PERIOD_MS;
  // Workflow-safe clock: inside the sandbox `Date.now()` is Temporal's
  // deterministic, replay-stable time, not the host's.
  const startedAtMs = Date.now();
  const checks: HealthCheckActivityOutput[] = [];

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const waitMs = healthCheckSleepMs(iteration, Date.now() - startedAtMs, iterations, periodMs);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    checks.push(await HealthCheckActivity({ iteration }));
  }

  return {
    iterations,
    checks,
    elapsedMs: Date.now() - startedAtMs,
  };
}
