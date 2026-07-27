/**
 * Activity implementations for the hooks feature (ADR-0008). Activities run
 * in the temporal-worker MAIN thread (node), so — unlike workflows.ts — they
 * may use the feature's db handle and shared packages.
 */
import { purgeIncomingWebhooks } from "./jobs";

/** Sole argument of {@link HooksPurgeActivity}. */
export interface HooksPurgeActivityInput {
  /** Reserved for future knobs (one-arg-in convention); no fields today. */
  readonly _?: never;
}

/** Sole return value of {@link HooksPurgeActivity}. */
export interface HooksPurgeActivityOutput {
  readonly counts: Awaited<ReturnType<typeof purgeIncomingWebhooks>>;
}

/**
 * One incoming-webhook purge pass — the same batched-delete body the k8s CronJob ran,
 * with its counts persisted in the workflow result instead of vanishing with
 * the Job pod's logs.
 *
 * @public - registered on the worker via features/_generated/activities.gen.ts,
 * called by HooksPurgeWorkflow.
 */
export async function HooksPurgeActivity(
  _input: HooksPurgeActivityInput,
): Promise<HooksPurgeActivityOutput> {
  const counts = await purgeIncomingWebhooks();
  return { counts };
}
