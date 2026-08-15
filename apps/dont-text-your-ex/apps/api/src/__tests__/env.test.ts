import { afterEach, describe, expect, it } from "vitest";
import { apiPort, appleBundleId, resetEnvCache, shouldResetDatabase } from "../env";

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
});
