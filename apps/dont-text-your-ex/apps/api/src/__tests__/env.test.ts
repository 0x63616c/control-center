import { afterEach, describe, expect, it } from "vitest";
import {
  apiPort,
  appleBundleId,
  isKubernetesRuntime,
  moderationNarrativeKeyringSource,
  resetEnvCache,
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

  it("identifies the Kubernetes runtime through the centralized environment registry", () => {
    delete process.env.KUBERNETES_SERVICE_HOST;
    resetEnvCache();
    expect(isKubernetesRuntime()).toBe(false);

    process.env.KUBERNETES_SERVICE_HOST = "10.96.0.1";
    resetEnvCache();
    expect(isKubernetesRuntime()).toBe(true);
  });

  it("reads the moderation narrative keyring from the configured secret file", () => {
    process.env.APP_ENV = "production";
    process.env.MODERATION_NARRATIVE_KEYRING_FILE = new URL(
      "./fixtures/moderation-keyring.json",
      import.meta.url,
    ).pathname;
    resetEnvCache();

    expect(moderationNarrativeKeyringSource()).toEqual({
      activeKeyId: "test-v1",
      keys: { "test-v1": "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=" },
    });
  });

  it("fails closed when the production moderation narrative keyring is unavailable", () => {
    process.env.APP_ENV = "production";
    process.env.MODERATION_NARRATIVE_KEYRING_FILE = "/definitely/missing/moderation-keyring";
    resetEnvCache();

    expect(() => moderationNarrativeKeyringSource()).toThrow(
      "MODERATION_NARRATIVE_KEYRING_FILE must contain valid JSON",
    );
  });
});
