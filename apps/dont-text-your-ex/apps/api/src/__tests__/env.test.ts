import { afterEach, describe, expect, it } from "vitest";
import {
  accountDeletionKeyringSource,
  apiPort,
  appleBundleId,
  erasureJournalDirectory,
  isolatedRestoreReplayConfig,
  resetEnvCache,
  restoreTombstoneHmacKeyringSource,
  restoreTombstoneSigningKeyringSource,
  shouldResetDatabase,
} from "../env";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  resetEnvCache();
});

describe("Don’t Text Your Ex API configuration", () => {
  it("preserves the registered Apple bundle ID by default", () => {
    delete process.env.APPLE_BUNDLE_ID;
    resetEnvCache();

    expect(appleBundleId()).toBe("co.worldwidewebb.textyourex");
  });

  it("uses the API container port by default", () => {
    delete process.env.PORT;
    resetEnvCache();

    expect(apiPort()).toBe(8787);
  });

  it("enables destructive reset only when explicitly requested outside production", () => {
    process.env.TYE_RESET = "1";
    process.env.APP_ENV = "development";
    resetEnvCache();
    expect(shouldResetDatabase()).toBe(true);

    process.env.APP_ENV = "production";
    resetEnvCache();
    expect(shouldResetDatabase()).toBe(false);
  });

  it("fails closed when production deletion keyrings or the erasure journal are unavailable", () => {
    process.env.APP_ENV = "production";
    delete process.env.ACCOUNT_DELETION_KEYRING;
    delete process.env.RESTORE_TOMBSTONE_HMAC_KEYRING;
    delete process.env.RESTORE_TOMBSTONE_SIGNING_KEYRING;
    delete process.env.ERASURE_JOURNAL_DIR;
    process.env.ACCOUNT_DELETION_KEYRING_FILE = "/missing/account-deletion-keyring";
    process.env.RESTORE_TOMBSTONE_HMAC_KEYRING_FILE = "/missing/tombstone-hmac-keyring";
    process.env.RESTORE_TOMBSTONE_SIGNING_KEYRING_FILE = "/missing/tombstone-signing-keyring";
    resetEnvCache();

    expect(() => accountDeletionKeyringSource()).toThrow(/ACCOUNT_DELETION_KEYRING_FILE/);
    expect(() => restoreTombstoneHmacKeyringSource()).toThrow(
      /RESTORE_TOMBSTONE_HMAC_KEYRING_FILE/,
    );
    expect(() => restoreTombstoneSigningKeyringSource()).toThrow(
      /RESTORE_TOMBSTONE_SIGNING_KEYRING_FILE/,
    );
    expect(() => erasureJournalDirectory()).toThrow(/ERASURE_JOURNAL_DIR/);
  });

  it("accepts explicit production deletion keyrings and the mounted erasure journal", () => {
    const accountDeletion = { activeKeyId: "delete-v1", keys: { "delete-v1": "delete-key" } };
    const tombstoneHmac = { activeKeyId: "hmac-v1", keys: { "hmac-v1": "hmac-key" } };
    const tombstoneSigning = { activeKeyId: "sign-v1", keys: { "sign-v1": "signing-key" } };
    process.env.APP_ENV = "production";
    process.env.ACCOUNT_DELETION_KEYRING = JSON.stringify(accountDeletion);
    process.env.RESTORE_TOMBSTONE_HMAC_KEYRING = JSON.stringify(tombstoneHmac);
    process.env.RESTORE_TOMBSTONE_SIGNING_KEYRING = JSON.stringify(tombstoneSigning);
    process.env.ERASURE_JOURNAL_DIR = "/erasure-journal";
    resetEnvCache();

    expect(accountDeletionKeyringSource()).toEqual(accountDeletion);
    expect(restoreTombstoneHmacKeyringSource()).toEqual(tombstoneHmac);
    expect(restoreTombstoneSigningKeyringSource()).toEqual(tombstoneSigning);
    expect(erasureJournalDirectory()).toBe("/erasure-journal");
  });

  it("permits restore replay only in an isolated scratch environment with traffic disabled", () => {
    process.env.DTYE_RESTORE_MODE = "production";
    process.env.DTYE_RESTORE_TRAFFIC_DISABLED = "true";
    process.env.ERASURE_JOURNAL_DIR = "/erasure-journal";
    resetEnvCache();
    expect(() => isolatedRestoreReplayConfig()).toThrow(/isolated-scratch/);

    process.env.DTYE_RESTORE_MODE = "isolated-scratch";
    process.env.DTYE_RESTORE_TRAFFIC_DISABLED = "false";
    resetEnvCache();
    expect(() => isolatedRestoreReplayConfig()).toThrow(/traffic to be disabled/);

    process.env.DTYE_RESTORE_TRAFFIC_DISABLED = "true";
    resetEnvCache();
    expect(isolatedRestoreReplayConfig()).toEqual({
      hmacKeyringFile: "/run/account-deletion-secrets/RESTORE_TOMBSTONE_HMAC_KEYRING",
      signingKeyringFile: "/run/account-deletion-secrets/RESTORE_TOMBSTONE_SIGNING_KEYRING",
      journalDirectory: "/erasure-journal",
    });
  });
});
