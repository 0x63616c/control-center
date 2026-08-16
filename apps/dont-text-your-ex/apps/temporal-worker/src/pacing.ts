export const HEALTH_CHECK_PERIOD_MS = 60_000;

export function healthCheckSleepMs(
  iteration: number,
  elapsedMs: number,
  iterations: number,
  periodMs: number,
): number {
  if (!Number.isInteger(iterations) || iterations < 1)
    throw new Error("iterations must be positive");
  const targetMs = (iteration * periodMs) / iterations;
  return Math.max(0, targetMs - elapsedMs);
}
