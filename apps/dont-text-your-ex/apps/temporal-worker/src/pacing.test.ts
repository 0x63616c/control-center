import { expect, test } from "vitest";
import { healthCheckSleepMs } from "./pacing";

test("health checks target absolute slots instead of accumulating activity latency", () => {
  expect(healthCheckSleepMs(2, 27_000, 5, 60_000)).toBe(0);
  expect(healthCheckSleepMs(3, 27_000, 5, 60_000)).toBe(9_000);
});
