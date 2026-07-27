/**
 * Activity implementations for the wakes feature (ADR-0008). Activities run
 * in the temporal-worker MAIN thread (node), so — unlike workflows.ts — they
 * may use the feature's db handle and shared packages.
 */
import { db } from "./db";
import { purgeWakePhotos } from "./jobs";

/** Sole argument of {@link WakesPurgeActivity}. */
export interface WakesPurgeActivityInput {
  /** Reserved for future knobs (one-arg-in convention); no fields today. */
  readonly _?: never;
}

/** Sole return value of {@link WakesPurgeActivity}. */
export interface WakesPurgeActivityOutput {
  readonly counts: Awaited<ReturnType<typeof purgeWakePhotos>>;
}

/**
 * One wake-photo purge pass — the same batched-delete body the k8s CronJob ran,
 * with its counts persisted in the workflow result instead of vanishing with
 * the Job pod's logs.
 *
 * @public - registered on the worker via features/_generated/activities.gen.ts,
 * called by WakesPurgeWorkflow.
 */
export async function WakesPurgeActivity(
  _input: WakesPurgeActivityInput,
): Promise<WakesPurgeActivityOutput> {
  const counts = await purgeWakePhotos(db);
  return { counts };
}
