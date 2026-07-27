/**
 * Activity implementations for the weather feature (ADR-0008). Activities run
 * in the temporal-worker MAIN thread (node), so — unlike workflows.ts — they
 * may use the feature's db handle and shared packages.
 */
import { db } from "./db";
import { purgeWeatherData, type WeatherPurgeCounts } from "./jobs";

/** Sole argument of {@link WeatherPurgeActivity}. */
export interface WeatherPurgeActivityInput {
  /** Reserved for future knobs (one-arg-in convention); no fields today. */
  readonly _?: never;
}

/** Sole return value of {@link WeatherPurgeActivity}. */
export interface WeatherPurgeActivityOutput {
  readonly counts: WeatherPurgeCounts;
}

/**
 * One weather purge pass — the same batched-delete body the k8s CronJob used
 * to run via `bun cron.js weather-purge`, now with its counts persisted in the
 * workflow result instead of vanishing with the Job pod's logs.
 *
 * @public - registered on the worker via features/_generated/activities.gen.ts,
 * called by WeatherPurgeWorkflow.
 */
export async function WeatherPurgeActivity(
  _input: WeatherPurgeActivityInput,
): Promise<WeatherPurgeActivityOutput> {
  const counts = await purgeWeatherData(db);
  return { counts };
}
