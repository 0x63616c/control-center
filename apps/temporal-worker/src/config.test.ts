import { __resetEnvCache, ENV } from "@www/platform/env";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { temporalWorkerConfig } from "./config";

// Keys this test pokes into process.env — cleared between cases so one test's
// override never leaks into the next, same pattern as
// packages/platform/test/env.test.ts.
const TOUCHED = ["TEMPORAL_OTEL_COLLECTOR_URL"];

function clear() {
  for (const k of TOUCHED) delete process.env[k];
  __resetEnvCache(ENV);
}

beforeEach(clear);
afterEach(clear);

describe("temporalWorkerConfig (issue #233)", () => {
  test("otelCollectorUrl defaults to the in-cluster collector Service, no env override required", () => {
    const config = temporalWorkerConfig();
    expect(config.otelCollectorUrl).toBe(
      "http://temporal-otel-collector.temporal.svc.cluster.local:4317",
    );
  });

  test("otelCollectorUrl is read from TEMPORAL_OTEL_COLLECTOR_URL when set", () => {
    process.env.TEMPORAL_OTEL_COLLECTOR_URL = "grpc://otel-collector.example:4317";
    const config = temporalWorkerConfig();
    expect(config.otelCollectorUrl).toBe("grpc://otel-collector.example:4317");
  });
});
