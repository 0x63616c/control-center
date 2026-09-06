import { beforeEach, describe, expect, it, vi } from "vitest";
import { InviteRateLimitErrorSchema, UserIdSchema } from "../../../../contracts";

const store = vi.hoisted(() => ({
  getJarPreviewByCode: vi.fn(),
  joinJarByCode: vi.fn(),
  userIdForToken: vi.fn(),
  withActiveAccountRequest: vi.fn(async (_userId: string, operation: () => Promise<unknown>) => ({
    active: true as const,
    value: await operation(),
  })),
}));

vi.mock("../store", () => store);

import { buildApp } from "../server";

describe("invite-code route boundary", () => {
  beforeEach(() => {
    store.getJarPreviewByCode.mockReset();
    store.joinJarByCode.mockReset();
    store.userIdForToken.mockReset();
    store.userIdForToken.mockImplementation(async (token: string) =>
      token === "sess_otherboundary"
        ? UserIdSchema.parse("usr_otherboundary")
        : UserIdSchema.parse("usr_routeboundary"),
    );
    store.getJarPreviewByCode.mockResolvedValue(null);
    store.joinJarByCode.mockResolvedValue(null);
  });

  it("rejects malformed route params before persistence", async () => {
    const response = await buildApp().request("/api/jars/code/not-valid!", {
      headers: { Authorization: "Bearer sess_routeboundary" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(store.getJarPreviewByCode).not.toHaveBeenCalled();
  });

  it("normalizes a valid route param before persistence", async () => {
    const response = await buildApp().request("/api/jars/code/xex24k", {
      headers: { Authorization: "Bearer sess_routeboundary" },
    });

    expect(response.status).toBe(404);
    expect(store.getJarPreviewByCode).toHaveBeenCalledWith("XEX24K");
  });

  it("rate limits invite preview probes by both authenticated user and client IP", async () => {
    const app = buildApp();
    const request = (token: string, ip: string) =>
      app.request("/api/jars/code/BAD!", {
        headers: {
          Authorization: `Bearer ${token}`,
          "CF-Connecting-IP": ip,
        },
      });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await request("sess_routeboundary", "203.0.113.10")).status).toBe(400);
    }

    const exhausted = await request("sess_routeboundary", "203.0.113.10");
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers.get("Retry-After")).toBe("3");
    expect(InviteRateLimitErrorSchema.parse(await exhausted.json())).toEqual({
      error: "invite_rate_limited",
      retryAfterSeconds: 3,
    });

    expect((await request("sess_routeboundary", "203.0.113.11")).status).toBe(429);
    expect((await request("sess_otherboundary", "203.0.113.10")).status).toBe(429);
    expect((await request("sess_otherboundary", "203.0.113.11")).status).toBe(400);
  });

  it("shares the probe budget with join attempts without changing a normal join response", async () => {
    const app = buildApp();
    const headers = {
      Authorization: "Bearer sess_routeboundary",
      "CF-Connecting-IP": "203.0.113.20",
      "Content-Type": "application/json",
    };

    const normal = await app.request("/api/jars/join", {
      method: "POST",
      headers,
      body: JSON.stringify({ code: "XEX24K" }),
    });
    expect(normal.status).toBe(404);

    for (let attempt = 1; attempt < 20; attempt += 1) {
      await app.request("/api/jars/code/BAD!", { headers });
    }
    const exhaustedJoin = await app.request("/api/jars/join", {
      method: "POST",
      headers,
      body: JSON.stringify({ code: "XEX24K" }),
    });
    expect(exhaustedJoin.status).toBe(429);
    expect(InviteRateLimitErrorSchema.parse(await exhaustedJoin.json()).error).toBe(
      "invite_rate_limited",
    );
  });
});
