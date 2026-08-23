import { beforeEach, describe, expect, it, vi } from "vitest";
import { InviteRateLimitErrorSchema, UserIdSchema } from "../../../../contracts";

const store = vi.hoisted(() => ({
  getJarPreviewByCode: vi.fn(),
  joinJarByCode: vi.fn(),
  userIdForToken: vi.fn(),
}));

vi.mock("../store", () => store);

import { buildApp } from "../server";

function previewRequest(
  app: ReturnType<typeof buildApp>,
  code: string,
  headers: Readonly<Record<string, string>>,
) {
  return app.request("/api/jars/preview", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

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

  it("rejects malformed preview bodies before persistence and exposes no code-in-URL route", async () => {
    const app = buildApp();
    const response = await previewRequest(app, "not-valid!", {
      Authorization: "Bearer sess_routeboundary",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(store.getJarPreviewByCode).not.toHaveBeenCalled();
    expect(
      (
        await app.request("/api/jars/code/SECRET", {
          headers: { Authorization: "Bearer sess_routeboundary" },
        })
      ).status,
    ).toBe(404);
  });

  it("normalizes a valid preview body before persistence", async () => {
    const response = await previewRequest(buildApp(), "xex24k", {
      Authorization: "Bearer sess_routeboundary",
    });

    expect(response.status).toBe(404);
    expect(store.getJarPreviewByCode).toHaveBeenCalledWith("XEX24K", "usr_routeboundary");
  });

  it("rate limits invite preview probes by both authenticated user and client IP", async () => {
    const app = buildApp();
    const request = (token: string, ip: string) =>
      previewRequest(app, "BAD!", {
        Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": ip,
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
      await previewRequest(app, "BAD!", headers);
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

  it("wires injected origin budgets ahead of the real invite handler", async () => {
    const app = buildApp({
      rateLimit: {
        clock: () => 0,
        limits: {
          general: { capacity: 10, windowMs: 60_000 },
          auth: { capacity: 10, windowMs: 60_000 },
          invite: { capacity: 1, windowMs: 60_000 },
          reportEvidence: { capacity: 10, windowMs: 60_000 },
          mutation: { capacity: 10, windowMs: 60_000 },
        },
      },
    });
    const headers = {
      Authorization: "Bearer sess_routeboundary",
      "CF-Connecting-IP": "203.0.113.70",
    };

    expect((await previewRequest(app, "ABC234", headers)).status).toBe(404);
    expect(store.getJarPreviewByCode).toHaveBeenCalledOnce();
    const denied = await previewRequest(app, "ABC234", headers);

    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBe("60");
    expect(InviteRateLimitErrorSchema.parse(await denied.json())).toEqual({
      error: "invite_rate_limited",
      retryAfterSeconds: 60,
    });
    expect(store.getJarPreviewByCode).toHaveBeenCalledOnce();
    expect((await app.request("/api/health", { headers })).status).toBe(200);
  });

  it("rejects an exhausted client before resolving its authenticated session", async () => {
    const app = buildApp({
      rateLimit: {
        clock: () => 0,
        limits: {
          general: { capacity: 1, windowMs: 60_000 },
          auth: { capacity: 10, windowMs: 60_000 },
          invite: { capacity: 10, windowMs: 60_000 },
          reportEvidence: { capacity: 10, windowMs: 60_000 },
          mutation: { capacity: 10, windowMs: 60_000 },
        },
      },
    });
    const headers = {
      Authorization: "Bearer sess_routeboundary",
      "CF-Connecting-IP": "203.0.113.71",
    };

    expect((await previewRequest(app, "ABC234", headers)).status).toBe(404);
    expect(store.userIdForToken).toHaveBeenCalledOnce();
    expect(store.getJarPreviewByCode).toHaveBeenCalledOnce();
    store.userIdForToken.mockClear();
    store.getJarPreviewByCode.mockClear();

    const denied = await previewRequest(app, "ABC234", headers);
    expect(denied.status).toBe(429);
    expect(store.userIdForToken).not.toHaveBeenCalled();
    expect(store.getJarPreviewByCode).not.toHaveBeenCalled();
  });

  it("enforces the authenticated-user bucket after session resolution", async () => {
    const app = buildApp({
      rateLimit: {
        clock: () => 0,
        limits: {
          general: { capacity: 1, windowMs: 60_000 },
          auth: { capacity: 10, windowMs: 60_000 },
          invite: { capacity: 10, windowMs: 60_000 },
          reportEvidence: { capacity: 10, windowMs: 60_000 },
          mutation: { capacity: 10, windowMs: 60_000 },
        },
      },
    });

    expect(
      (
        await previewRequest(app, "ABC234", {
          Authorization: "Bearer sess_routeboundary",
          "CF-Connecting-IP": "203.0.113.72",
        })
      ).status,
    ).toBe(404);
    const denied = await previewRequest(app, "ABC234", {
      Authorization: "Bearer sess_routeboundary",
      "CF-Connecting-IP": "203.0.113.73",
    });

    expect(denied.status).toBe(429);
    expect(store.userIdForToken).toHaveBeenCalledTimes(2);
    expect(store.getJarPreviewByCode).toHaveBeenCalledOnce();
  });
});
