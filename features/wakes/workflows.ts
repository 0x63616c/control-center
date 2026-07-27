/**
 * Workflow definitions for the wakes feature (ADR-0008). Loaded ONLY inside
 * the SDK's determinism sandbox via the generated barrel — may import
 * `@temporalio/workflow` and pure local modules only; side effects live in
 * activities.ts.
 */
import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities";
import type { WakesPurgeActivityOutput } from "./activities";

// startToCloseTimeout bounds ONE purge attempt; the batch caps in jobs.ts
// bound the SQL work itself. Retries capped low: the next daily run picks up
// whatever remains.
const { WakesPurgeActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "25 minutes",
  retry: { maximumAttempts: 2 },
});

/** Sole argument of {@link WakesPurgeWorkflow}. */
export interface WakesPurgeWorkflowInput {
  /** Reserved for future knobs (one-arg-in convention); no fields today. */
  readonly _?: never;
}

/**
 * Runs one daily wake-photo retention purge as a single activity call.
 *
 * @public - the workflow type name is exactly `WakesPurgeWorkflow`
 * (declared in temporal.ts; workflow-names.test.ts asserts they agree).
 */
export async function WakesPurgeWorkflow(
  _input: WakesPurgeWorkflowInput,
): Promise<WakesPurgeActivityOutput> {
  return await WakesPurgeActivity({});
}
