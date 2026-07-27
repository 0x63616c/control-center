/**
 * Activity implementations for the guest-wifi feature (ADR-0008). Activities run
 * in the temporal-worker MAIN thread (node), so — unlike workflows.ts — they
 * may use the feature's db handle and shared packages.
 */
import { db } from "./db";
import { purgePortalData } from "./jobs";

/** Sole argument of {@link GuestWifiPurgeActivity}. */
export interface GuestWifiPurgeActivityInput {
  /** Reserved for future knobs (one-arg-in convention); no fields today. */
  readonly _?: never;
}

/** Sole return value of {@link GuestWifiPurgeActivity}. */
export interface GuestWifiPurgeActivityOutput {
  readonly counts: Awaited<ReturnType<typeof purgePortalData>>;
}

/**
 * One guest-portal-data purge pass — the same batched-delete body the k8s CronJob ran,
 * with its counts persisted in the workflow result instead of vanishing with
 * the Job pod's logs.
 *
 * @public - registered on the worker via features/_generated/activities.gen.ts,
 * called by GuestWifiPurgeWorkflow.
 */
export async function GuestWifiPurgeActivity(
  _input: GuestWifiPurgeActivityInput,
): Promise<GuestWifiPurgeActivityOutput> {
  const counts = await purgePortalData(db);
  return { counts };
}
