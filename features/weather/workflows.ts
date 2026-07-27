/**
 * Workflow definitions for the weather feature (ADR-0008).
 *
 * This file is NOT bundled by our Dockerfile. The Worker hands the generated
 * barrel (features/_generated/workflows.gen.ts) to the SDK's own webpack+swc
 * pipeline at boot, which is what enforces the determinism sandbox — so it may
 * only import `@temporalio/workflow` and pure local modules. No logger, no
 * `node:*`, no I/O: anything with a side effect belongs in activities.ts.
 */
import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities";
import type { WeatherPurgeActivityOutput } from "./activities";

// startToCloseTimeout bounds ONE purge attempt; the batch caps inside the
// activity (500 batches × 20k rows per table) bound the SQL work itself.
// Retries are capped low: the next daily run picks up whatever remains, so a
// purge that fails twice should surface as a red run, not grind in place.
const { WeatherPurgeActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "25 minutes",
  retry: { maximumAttempts: 2 },
});

/** Sole argument of {@link WeatherPurgeWorkflow}. */
export interface WeatherPurgeWorkflowInput {
  /** Reserved for future knobs (one-arg-in convention); no fields today. */
  readonly _?: never;
}

/**
 * Runs one daily weather retention purge (30-day cutoff on recorded_at) as a
 * single activity call — the workflow layer exists for the schedule, history,
 * and retry semantics, not for orchestration.
 *
 * @public - the workflow type name is exactly `WeatherPurgeWorkflow`
 * (declared in temporal.ts; workflow-names.test.ts asserts they agree).
 */
export async function WeatherPurgeWorkflow(
  _input: WeatherPurgeWorkflowInput,
): Promise<WeatherPurgeActivityOutput> {
  return await WeatherPurgeActivity({});
}
