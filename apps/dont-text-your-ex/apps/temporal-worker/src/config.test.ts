import { describe, expect, test } from "vitest";
import { parseTemporalWorkerConfig } from "./config";

const valid = {
  TEMPORAL_ADDRESS: "temporal:7233",
  TEMPORAL_NAMESPACE: "dont-text-your-ex",
  TEMPORAL_TASK_QUEUE: "main",
  DATABASE_URL: "postgresql://example.invalid/db",
  METRICS_PORT: 9464,
  TEMPORAL_OTEL_COLLECTOR_URL: "http://otel:4317",
};

describe("DTYE worker config", () => {
  test("accepts only the product namespace and exact main task queue", () => {
    expect(parseTemporalWorkerConfig(valid)).toMatchObject({
      namespace: "dont-text-your-ex",
      taskQueue: "main",
    });
  });

  test("fails before connecting when the queue drifts", () => {
    expect(() => parseTemporalWorkerConfig({ ...valid, TEMPORAL_TASK_QUEUE: "wrong" })).toThrow(
      /task queue must be main/,
    );
  });
});
