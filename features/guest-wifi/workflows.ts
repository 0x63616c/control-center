/**
 * Workflow definitions for the guest-wifi feature (ADR-0008). Loaded ONLY inside
 * the SDK's determinism sandbox via the generated barrel — may import
 * `@temporalio/workflow` and pure local modules only; side effects live in
 * activities.ts.
 */
import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities";
import type { GuestWifiPurgeActivityOutput } from "./activities";

// startToCloseTimeout bounds ONE purge attempt; the batch caps in jobs.ts
// bound the SQL work itself. Retries capped low: the next daily run picks up
// whatever remains.
const { GuestWifiPurgeActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "25 minutes",
  retry: { maximumAttempts: 2 },
});

/** Sole argument of {@link GuestWifiPurgeWorkflow}. */
export interface GuestWifiPurgeWorkflowInput {
  /** Reserved for future knobs (one-arg-in convention); no fields today. */
  readonly _?: never;
}

/**
 * Runs one daily guest-portal-data retention purge as a single activity call.
 *
 * @public - the workflow type name is exactly `GuestWifiPurgeWorkflow`
 * (declared in temporal.ts; workflow-names.test.ts asserts they agree).
 */
export async function GuestWifiPurgeWorkflow(
  _input: GuestWifiPurgeWorkflowInput,
): Promise<GuestWifiPurgeActivityOutput> {
  return await GuestWifiPurgeActivity({});
}
