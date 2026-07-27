/**
 * Activity implementations for the deploys feature (ADR-0008). Activities run
 * in the temporal-worker MAIN thread (node), so — unlike workflows.ts — they
 * may use the feature's db handle and shared packages.
 */
import { db } from "./db";
import { purgeGithubRuns } from "./jobs";

/** Sole argument of {@link DeploysPurgeActivity}. */
export interface DeploysPurgeActivityInput {
  /** Reserved for future knobs (one-arg-in convention); no fields today. */
  readonly _?: never;
}

/** Sole return value of {@link DeploysPurgeActivity}. */
export interface DeploysPurgeActivityOutput {
  readonly counts: Awaited<ReturnType<typeof purgeGithubRuns>>;
}

/**
 * One GitHub-run purge pass — the same batched-delete body the k8s CronJob ran
 * via `bun cron.js deploys-purge`, with its counts persisted in the workflow
 * result instead of vanishing with the Job pod's logs.
 *
 * @public - registered on the worker via features/_generated/activities.gen.ts,
 * called by DeploysPurgeWorkflow.
 */
export async function DeploysPurgeActivity(
  _input: DeploysPurgeActivityInput,
): Promise<DeploysPurgeActivityOutput> {
  const counts = await purgeGithubRuns(db);
  return { counts };
}
