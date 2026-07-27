import { describe, expect, it } from "vitest";
import { HEALTH_CHECK_PERIOD_MS, healthCheckSleepMs } from "./pacing";

describe("healthCheckSleepMs", () => {
  it("splits the minute into N even slots (the ticket's N=5 → 12s example)", () => {
    const slots = [0, 1, 2, 3, 4].map((i) => healthCheckSleepMs(i, 0, 5));
    expect(slots).toEqual([0, 12_000, 24_000, 36_000, 48_000]);
  });

  it("subtracts the time already spent, so a 1s activity does not shift later slots", () => {
    // Iteration 0 fired immediately and its activity took 1s. Iteration 1 is
    // still due at 12s, so only 11s of sleep is left — not another full 12s.
    expect(healthCheckSleepMs(1, 1_000, 5)).toBe(11_000);
    // Same again one slot later: due at 24s, 13s spent → 11s.
    expect(healthCheckSleepMs(2, 13_000, 5)).toBe(11_000);
  });

  it("never returns a negative sleep when a run is already behind", () => {
    expect(healthCheckSleepMs(1, 30_000, 5)).toBe(0);
  });

  it("defaults to the one-minute period", () => {
    expect(healthCheckSleepMs(1, 0, 2)).toBe(HEALTH_CHECK_PERIOD_MS / 2);
  });

  it("honours a non-default period", () => {
    expect(healthCheckSleepMs(1, 0, 4, 10_000)).toBe(2_500);
  });

  it("rejects a zero/negative iteration count rather than dividing by zero", () => {
    expect(() => healthCheckSleepMs(0, 0, 0)).toThrow(/iterations must be >= 1/);
  });
});
