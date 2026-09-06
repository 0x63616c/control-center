import { describe, expect, test } from "vitest";
import { parseTemporalWorkerConfig } from "./config";

const valid = {
  TEMPORAL_ADDRESS: "temporal:7233",
  TEMPORAL_NAMESPACE: "dont-text-your-ex",
  TEMPORAL_TASK_QUEUE: "main",
  DATABASE_URL: "postgresql://example.invalid/db",
  METRICS_PORT: 9464,
  TEMPORAL_OTEL_COLLECTOR_URL: "http://otel:4317",
  APNS_KEY_ID: "key-id",
  APNS_TEAM_ID: "team-id",
  APNS_KEY_CONTENT: "private-key",
  PUSH_TOKEN_KEYRING: '{"activeKeyId":"v1","keys":{"v1":"example"}}',
  SIWA_KEY_ID: "siwa-key-id",
  SIWA_TEAM_ID: "siwa-team-id",
  SIWA_KEY_CONTENT: "siwa-private-key",
  APPLE_BUNDLE_ID: "co.worldwidewebb.textyourex",
  ACCOUNT_DELETION_KEYRING:
    '{"activeKeyId":"v1","keys":{"v1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}',
  RESTORE_TOMBSTONE_HMAC_KEYRING:
    '{"activeKeyId":"v1","keys":{"v1":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="}}',
  RESTORE_TOMBSTONE_SIGNING_KEYRING:
    '{"activeKeyId":"v1","keys":{"v1":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI="}}',
  ERASURE_JOURNAL_DIR: "/mnt/erasure-journal",
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

  test("fails before connecting when the namespace drifts", () => {
    expect(() =>
      parseTemporalWorkerConfig({ ...valid, TEMPORAL_NAMESPACE: "control-center" }),
    ).toThrow(/namespace must be dont-text-your-ex/);
  });

  test("fails before connecting when notification secrets are absent", () => {
    expect(() => parseTemporalWorkerConfig({ ...valid, APNS_KEY_CONTENT: undefined })).toThrow(
      /notification delivery secrets must be configured/,
    );
  });

  test("fails before connecting when account deletion secrets are absent", () => {
    for (const key of [
      "SIWA_KEY_ID",
      "SIWA_TEAM_ID",
      "SIWA_KEY_CONTENT",
      "APPLE_BUNDLE_ID",
      "ACCOUNT_DELETION_KEYRING",
      "RESTORE_TOMBSTONE_HMAC_KEYRING",
      "RESTORE_TOMBSTONE_SIGNING_KEYRING",
      "ERASURE_JOURNAL_DIR",
    ] as const) {
      expect(() => parseTemporalWorkerConfig({ ...valid, [key]: undefined }), key).toThrow(
        /account deletion secrets must be configured/,
      );
    }
  });
});
