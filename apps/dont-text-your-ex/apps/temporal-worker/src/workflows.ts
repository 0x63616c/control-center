import { proxyActivities, sleep } from "@temporalio/workflow";
import type * as activities from "./activities";
import { HEALTH_CHECK_PERIOD_MS, healthCheckSleepMs } from "./pacing";

export interface DtyeHealthCheckWorkflowInput {
  readonly iterations: number;
  readonly periodMs?: number;
}
export interface DtyeHealthCheckWorkflowOutput {
  readonly status: "healthy";
  readonly checks: number;
}

const { DtyeHealthCheckActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 seconds",
  retry: { maximumAttempts: 2 },
});

export async function DtyeHealthCheckWorkflow(
  input: DtyeHealthCheckWorkflowInput,
): Promise<DtyeHealthCheckWorkflowOutput> {
  const periodMs = input.periodMs ?? HEALTH_CHECK_PERIOD_MS;
  const startedAtMs = Date.now();
  for (let iteration = 0; iteration < input.iterations; iteration += 1) {
    const waitMs = healthCheckSleepMs(
      iteration,
      Date.now() - startedAtMs,
      input.iterations,
      periodMs,
    );
    if (waitMs > 0) await sleep(waitMs);
    await DtyeHealthCheckActivity({ iteration });
  }
  return { status: "healthy", checks: input.iterations };
}
