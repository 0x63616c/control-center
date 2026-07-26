/**
 * The pacing maths for `HealthCheckWorkflow`, kept as a pure function so it is
 * unit-testable without a Temporal server (the workflow itself can only be
 * exercised inside the SDK's deterministic sandbox).
 *
 * The shape of the problem: the workflow is scheduled once a MINUTE, and inside
 * that minute it must fire `N` activities spread EVENLY across the period. The
 * naive `sleep(period / N)` between calls drifts, because each activity itself
 * takes time — with N=5 and a 1s activity you get checks at 0s, 13s, 26s, 39s,
 * 52s and the last slot is short. So the schedule is absolute, not relative:
 * iteration `i` is DUE at `i * (period / N)` measured from workflow start, and
 * the sleep before it is whatever is left of that budget after the time already
 * spent. Slow activities eat their own slot instead of pushing every later one.
 */

/** The `HealthCheckWorkflow` cron period. One run per minute. */
export const HEALTH_CHECK_PERIOD_MS = 60_000;

/**
 * How long to sleep before firing iteration `iteration` (0-based).
 *
 * @param iteration - 0-based index of the activity about to be run.
 * @param elapsedMs - time already spent in this workflow run, from its start.
 * @param iterations - total activities this run will fire (`N`).
 * @param periodMs - the whole budget to spread them across.
 * @returns milliseconds to sleep; never negative (a late run just fires now).
 *
 * @public - unit-tested in pacing.test.ts, consumed by workflows.ts.
 */
export function healthCheckSleepMs(
  iteration: number,
  elapsedMs: number,
  iterations: number,
  periodMs: number = HEALTH_CHECK_PERIOD_MS,
): number {
  if (iterations < 1) {
    throw new Error(`healthCheckSleepMs: iterations must be >= 1, got ${iterations}`);
  }
  const slotMs = periodMs / iterations;
  const dueAtMs = iteration * slotMs;
  return Math.max(0, dueAtMs - elapsedMs);
}
