import { describe, expect, it } from "vitest";
import { buildApp } from "../server";

describe("request JSON boundary", () => {
  it("rejects an invalid development-login body before touching persistence", async () => {
    const response = await buildApp().request("/api/auth/dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ as: "intruder" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });
});
