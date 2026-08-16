import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "../env";
import { buildApp } from "../server";

const originalAppEnv = process.env.APP_ENV;

afterEach(() => {
  if (originalAppEnv === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = originalAppEnv;
  resetEnvCache();
});

describe("request JSON boundary", () => {
  it("does not expose push registration, preferences, or notification targets without a session", async () => {
    const app = buildApp();
    const responses = await Promise.all([
      app.request("/api/push/devices", { method: "POST" }),
      app.request("/api/push/devices/disable", { method: "POST" }),
      app.request("/api/me/notification-preferences"),
      app.request("/api/me/notification-preferences", { method: "PATCH" }),
      app.request("/api/notifications/ntf_example/target"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
  });

  it("rejects an invalid development-login body before touching persistence", async () => {
    const response = await buildApp().request("/api/auth/dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ as: "intruder" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("hides development login and test reset seams in production", async () => {
    process.env.APP_ENV = "production";
    resetEnvCache();

    const devLogin = await buildApp().request("/api/auth/dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ as: "calum" }),
    });
    const testReset = await buildApp().request("/api/test/reset", { method: "POST" });

    expect(devLogin.status).toBe(404);
    expect(await devLogin.json()).toEqual({ error: "not_found" });
    expect(testReset.status).toBe(404);
    expect(await testReset.json()).toEqual({ error: "not_found" });
  });
});
