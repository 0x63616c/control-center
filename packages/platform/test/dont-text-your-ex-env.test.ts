import { describe, expect, test } from "vitest";
import { ENV } from "../env/manifest";
import { registrySpec } from "../env/registry";

describe("Don't Text Your Ex deletion environment manifest", () => {
  test("routes SIWA credentials only to the Temporal worker as secrets", () => {
    const spec = registrySpec(ENV);

    for (const key of ["SIWA_KEY_ID", "SIWA_TEAM_ID", "SIWA_KEY_CONTENT"] as const) {
      expect(spec[key], key).toMatchObject({
        _optionalSecret: true,
        _runtimes: ["temporal-worker"],
        _secret: true,
      });
    }
  });

  test("routes deletion and tombstone keyrings to the API and Temporal worker as secrets", () => {
    const spec = registrySpec(ENV);

    for (const key of [
      "ACCOUNT_DELETION_KEYRING",
      "RESTORE_TOMBSTONE_HMAC_KEYRING",
      "RESTORE_TOMBSTONE_SIGNING_KEYRING",
    ] as const) {
      expect(spec[key], key).toMatchObject({
        _optionalSecret: true,
        _runtimes: ["api", "temporal-worker"],
        _secret: true,
      });
    }
  });

  test("keeps the Apple client identity and journal path public and scoped to deletion runtimes", () => {
    const spec = registrySpec(ENV);

    expect(spec.APPLE_BUNDLE_ID).toMatchObject({
      _default: "co.worldwidewebb.textyourex",
      _hasDefault: true,
      _runtimes: ["api", "temporal-worker"],
      _secret: false,
    });
    expect(spec.ERASURE_JOURNAL_DIR).toMatchObject({
      _optional: true,
      _runtimes: ["api", "temporal-worker"],
      _secret: false,
    });
  });
});
