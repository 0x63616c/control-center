import { type Context, Hono } from "hono";
import { describe, expect, it } from "vitest";
import { UserIdSchema } from "../../../../contracts";
import type { Env } from "../api";
import {
  createOriginRateLimiter,
  type OriginRateLimitResponse,
  type OriginRateLimits,
  originClientRateLimit,
  originUserRateLimit,
} from "../origin-rate-limit";

const TEST_LIMITS = {
  general: { capacity: 2, windowMs: 60_000 },
  auth: { capacity: 2, windowMs: 60_000 },
  invite: { capacity: 2, windowMs: 60_000 },
  reportEvidence: { capacity: 2, windowMs: 60_000 },
  mutation: { capacity: 2, windowMs: 60_000 },
} as const;

function testApp(
  limits: OriginRateLimits = TEST_LIMITS,
  options: Readonly<{ maxBuckets?: number; clock?: () => number }> = {},
) {
  const app = new Hono<Env>();
  const limiter = createOriginRateLimiter({
    clock: options.clock ?? (() => 0),
    limits,
    maxBuckets: options.maxBuckets,
  });
  app.use("*", originClientRateLimit(limiter));
  app.use("*", async (context, next) => {
    const parsedUser = UserIdSchema.safeParse(context.req.header("X-Test-User"));
    context.set("userId", parsedUser.success ? parsedUser.data : null);
    context.set("token", null);
    await next();
  });
  app.use("*", originUserRateLimit(limiter));
  app.get("/api/health", (context) => context.json({ ok: true }));
  app.get("/api/me", (context) => context.json({ ok: true }));
  return app;
}

function classifiedTestApp(limits: OriginRateLimits = TEST_LIMITS) {
  const app = new Hono<Env>();
  const executions = new Map<string, number>();
  const limiter = createOriginRateLimiter({ clock: () => 0, limits });
  app.use("*", originClientRateLimit(limiter));
  app.use("*", async (context, next) => {
    context.set("userId", UserIdSchema.parse("usr_routeclasses"));
    context.set("token", null);
    await next();
  });
  app.use("*", originUserRateLimit(limiter));
  const handler = (name: string) => (context: Context<Env>) => {
    executions.set(name, (executions.get(name) ?? 0) + 1);
    return context.json({ ok: true });
  };
  app.post("/api/auth/apple", handler("auth"));
  app.post("/api/jars/preview", handler("invite"));
  app.post("/api/jars/join", handler("invite"));
  app.post("/api/jars/:id/reports", handler("reportEvidence"));
  app.post("/api/moderation/reports", handler("moderationReport"));
  app.patch("/api/me", handler("avatarUpload"));
  app.post("/api/jars", handler("mutation"));
  app.get("/api/me", handler("general"));
  return { app, executions };
}

describe("origin HTTP rate limit", () => {
  it("applies the broad public budget to health while preserving headerless in-cluster probes", async () => {
    const app = testApp();
    const headers = { "CF-Connecting-IP": "203.0.113.10" };

    expect((await app.request("/api/me", { headers })).status).toBe(200);
    expect((await app.request("/api/me", { headers })).status).toBe(200);
    const denied = await app.request("/api/me", { headers });

    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBe("30");
    const expected: OriginRateLimitResponse = {
      error: "rate_limited",
      routeClass: "general",
      retryAfterSeconds: 30,
    };
    expect(await denied.json()).toEqual(expected);
    expect((await app.request("/api/health", { headers })).status).toBe(429);
    expect((await app.request("/api/health")).status).toBe(200);
  });

  it("trusts only valid Cloudflare client IPs and fail-closes every other request together", async () => {
    const limits = {
      ...TEST_LIMITS,
      general: { capacity: 1, windowMs: 60_000 },
    };
    const invalidApp = testApp(limits);

    expect(
      (
        await invalidApp.request("/api/me", {
          headers: {
            "CF-Connecting-IP": "not-an-ip",
            "X-Forwarded-For": "203.0.113.20",
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await invalidApp.request("/api/me", {
          headers: {
            "CF-Connecting-IP": "still-not-an-ip",
            "X-Real-IP": "203.0.113.21",
          },
        })
      ).status,
    ).toBe(429);

    const missingApp = testApp(limits);
    expect(
      (
        await missingApp.request("/api/me", {
          headers: { "X-Forwarded-For": "203.0.113.30" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await missingApp.request("/api/me", {
          headers: { "X-Real-IP": "203.0.113.31" },
        })
      ).status,
    ).toBe(429);

    const validApp = testApp(limits);
    expect(
      (
        await validApp.request("/api/me", {
          headers: { "CF-Connecting-IP": "203.0.113.40" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await validApp.request("/api/me", {
          headers: { "CF-Connecting-IP": "2001:db8::40" },
        })
      ).status,
    ).toBe(200);
  });

  it("jointly enforces authenticated-user and client-IP buckets", async () => {
    const app = testApp({
      ...TEST_LIMITS,
      general: { capacity: 1, windowMs: 60_000 },
    });
    const request = (user: string, ip: string) =>
      app.request("/api/me", {
        headers: { "X-Test-User": user, "CF-Connecting-IP": ip },
      });

    expect((await request("usr_alice", "203.0.113.50")).status).toBe(200);
    expect((await request("usr_alice", "203.0.113.51")).status).toBe(429);
    expect((await request("usr_bob", "203.0.113.50")).status).toBe(429);
    expect((await request("usr_bob", "203.0.113.52")).status).toBe(200);
  });

  it("applies route-class budgets before handlers while ordinary mixed flows remain allowed", async () => {
    const limits = {
      general: { capacity: 100, windowMs: 60_000 },
      auth: { capacity: 1, windowMs: 60_000 },
      invite: { capacity: 1, windowMs: 60_000 },
      reportEvidence: { capacity: 1, windowMs: 60_000 },
      mutation: { capacity: 1, windowMs: 60_000 },
    } as const;
    const headers = { "CF-Connecting-IP": "203.0.113.60" };
    const { app, executions } = classifiedTestApp(limits);

    expect((await app.request("/api/auth/apple", { method: "POST", headers })).status).toBe(200);
    const deniedAuth = await app.request("/api/auth/apple", { method: "POST", headers });
    expect(deniedAuth.status).toBe(429);
    expect(await deniedAuth.json()).toEqual({
      error: "rate_limited",
      routeClass: "auth",
      retryAfterSeconds: 60,
    } satisfies OriginRateLimitResponse);
    expect(executions.get("auth")).toBe(1);

    expect((await app.request("/api/jars/preview", { method: "POST", headers })).status).toBe(200);
    const deniedJoin = await app.request("/api/jars/join", { method: "POST", headers });
    expect(deniedJoin.status).toBe(429);
    expect(await deniedJoin.json()).toEqual({
      error: "invite_rate_limited",
      retryAfterSeconds: 60,
    } satisfies OriginRateLimitResponse);
    expect(executions.get("invite")).toBe(1);

    expect(
      (await app.request("/api/jars/jar_one/reports", { method: "POST", headers })).status,
    ).toBe(200);
    const deniedReport = await app.request("/api/jars/jar_two/reports", {
      method: "POST",
      headers,
    });
    expect(deniedReport.status).toBe(429);
    expect(await deniedReport.json()).toMatchObject({ routeClass: "reportEvidence" });
    expect(executions.get("reportEvidence")).toBe(1);

    expect((await app.request("/api/jars", { method: "POST", headers })).status).toBe(200);
    const deniedMutation = await app.request("/api/jars", { method: "POST", headers });
    expect(deniedMutation.status).toBe(429);
    expect(await deniedMutation.json()).toMatchObject({ routeClass: "mutation" });
    expect(executions.get("mutation")).toBe(1);

    expect((await app.request("/api/me", { headers })).status).toBe(200);
    expect(executions.get("general")).toBe(1);
  });

  it("classifies moderation reports and profile uploads as report/evidence operations", async () => {
    const limits = {
      general: { capacity: 100, windowMs: 60_000 },
      auth: { capacity: 100, windowMs: 60_000 },
      invite: { capacity: 100, windowMs: 60_000 },
      reportEvidence: { capacity: 1, windowMs: 60_000 },
      mutation: { capacity: 100, windowMs: 60_000 },
    } as const;
    const headers = { "CF-Connecting-IP": "203.0.113.80" };

    const moderation = classifiedTestApp(limits);
    expect(
      (
        await moderation.app.request("/api/moderation/reports", {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(200);
    const deniedModeration = await moderation.app.request("/api/moderation/reports", {
      method: "POST",
      headers,
    });
    expect(await deniedModeration.json()).toMatchObject({ routeClass: "reportEvidence" });
    expect(moderation.executions.get("moderationReport")).toBe(1);

    const avatar = classifiedTestApp(limits);
    expect((await avatar.app.request("/api/me", { method: "PATCH", headers })).status).toBe(200);
    const deniedAvatar = await avatar.app.request("/api/me", { method: "PATCH", headers });
    expect(await deniedAvatar.json()).toMatchObject({ routeClass: "reportEvidence" });
    expect(avatar.executions.get("avatarUpload")).toBe(1);
  });

  it("bounds bucket cardinality without evicting active clients for rotating IPs", async () => {
    let now = 0;
    const limits = {
      ...TEST_LIMITS,
      general: { capacity: 100, windowMs: 60_000 },
    };
    const app = testApp(limits, { maxBuckets: 2, clock: () => now });
    const request = (ip: string) => app.request("/api/me", { headers: { "CF-Connecting-IP": ip } });

    expect((await request("203.0.113.90")).status).toBe(200);
    expect((await request("203.0.113.91")).status).toBe(200);
    const full = await request("203.0.113.92");
    expect(full.status).toBe(429);
    expect(full.headers.get("Retry-After")).toBe("60");
    expect(await full.json()).toMatchObject({ routeClass: "general" });

    // Existing active keys remain admitted; an attacker key was not substituted.
    expect((await request("203.0.113.90")).status).toBe(200);
    expect((await request("203.0.113.92")).status).toBe(429);

    now = 60_000;
    expect((await request("203.0.113.92")).status).toBe(200);
  });
});
