/**
 * Activity implementations for the felogs feature (ADR-0008). Activities run
 * in the temporal-worker MAIN thread (node), so — unlike workflows.ts — they
 * may use the feature's db handle and shared packages.
 */
import { db } from "./db";
import { purgeFrontendLogs } from "./jobs";

/** Sole argument of {@link FelogsPurgeActivity}. */
export interface FelogsPurgeActivityInput {
  /** Reserved for future knobs (one-arg-in convention); no fields today. */
  readonly _?: never;
}

/** Sole return value of {@link FelogsPurgeActivity}. */
export interface FelogsPurgeActivityOutput {
  readonly counts: Awaited<ReturnType<typeof purgeFrontendLogs>>;
}

/**
 * One frontend-log purge pass — the same batched-delete body the k8s CronJob ran,
 * with its counts persisted in the workflow result instead of vanishing with
 * the Job pod's logs.
 *
 * @public - registered on the worker via features/_generated/activities.gen.ts,
 * called by FelogsPurgeWorkflow.
 */
export async function FelogsPurgeActivity(
  _input: FelogsPurgeActivityInput,
): Promise<FelogsPurgeActivityOutput> {
  const counts = await purgeFrontendLogs(db);
  return { counts };
}
