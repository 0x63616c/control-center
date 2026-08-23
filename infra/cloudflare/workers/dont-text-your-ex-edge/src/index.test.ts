import { describe, expect, test, vi } from "vitest";
import worker, { type EdgeEnv } from "./index.ts";

type LimitCall = { key: string };

function binding(success = true) {
  return { limit: vi.fn(async (_input: LimitCall) => ({ success })) };
}

function env(overrides: Partial<EdgeEnv> = {}): EdgeEnv {
  return {
    GENERAL_RATE_LIMITER: binding(),
    AUTH_RATE_LIMITER: binding(),
    INVITE_RATE_LIMITER: binding(),
    REPORT_EVIDENCE_RATE_LIMITER: binding(),
    MUTATION_RATE_LIMITER: binding(),
    ...overrides,
  };
}

function request(path: string, method = "GET") {
  return new Request(`https://dont-text-your-ex.worldwidewebb.co${path}`, {
    method,
    headers: { "CF-Connecting-IP": "203.0.113.44" },
  });
}

const executionContext = {};

describe("Don't Text Your Ex edge limiter", () => {
  test.each([
    ["GET", "/api/me", "general", "GENERAL_RATE_LIMITER"],
    ["POST", "/api/auth/apple", "auth", "AUTH_RATE_LIMITER"],
    ["POST", "/api/jars/join", "invite", "INVITE_RATE_LIMITER"],
    ["POST", "/api/jars/preview", "invite", "INVITE_RATE_LIMITER"],
    ["POST", "/api/jars/jar-1/reports", "reportEvidence", "REPORT_EVIDENCE_RATE_LIMITER"],
    ["POST", "/api/moderation/reports", "reportEvidence", "REPORT_EVIDENCE_RATE_LIMITER"],
    ["PATCH", "/api/me", "reportEvidence", "REPORT_EVIDENCE_RATE_LIMITER"],
    ["POST", "/api/jars", "mutation", "MUTATION_RATE_LIMITER"],
  ])("%s %s applies the %s policy", async (method, path, _routeClass, bindingName) => {
    const bindings = env();
    const origin = vi.fn(async () => new Response("origin"));

    const response = await worker.fetch(request(path, method), bindings, executionContext, origin);

    expect(response.status).toBe(200);
    expect(origin).toHaveBeenCalledOnce();
    expect(bindings.GENERAL_RATE_LIMITER.limit).toHaveBeenCalledWith({
      key: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const specific = bindings[bindingName as keyof EdgeEnv];
    expect(specific.limit).toHaveBeenCalledWith({ key: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  test("health consumes the general public budget and passes through exactly once", async () => {
    const bindings = env();
    const origin = vi.fn(async () => new Response("healthy"));

    const response = await worker.fetch(request("/api/health"), bindings, executionContext, origin);

    expect(await response.text()).toBe("healthy");
    expect(origin).toHaveBeenCalledOnce();
    expect(bindings.GENERAL_RATE_LIMITER.limit).toHaveBeenCalledOnce();
    for (const limiter of [
      bindings.AUTH_RATE_LIMITER,
      bindings.INVITE_RATE_LIMITER,
      bindings.REPORT_EVIDENCE_RATE_LIMITER,
      bindings.MUTATION_RATE_LIMITER,
    ]) {
      expect(limiter.limit).not.toHaveBeenCalled();
    }
  });

  test("a denied specific budget returns private typed JSON without reaching origin", async () => {
    const bindings = env({ AUTH_RATE_LIMITER: binding(false) });
    const origin = vi.fn(async () => new Response("must not happen"));

    const response = await worker.fetch(
      request("/api/auth/apple", "POST"),
      bindings,
      executionContext,
      origin,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("X-DTYE-Rate-Limit-Layer")).toBe("edge");
    expect(await response.json()).toEqual({
      error: "rate_limited",
      routeClass: "auth",
      retryAfterSeconds: 60,
    });
    expect(origin).not.toHaveBeenCalled();
  });

  test("keeps invite denials compatible with the app's retry contract", async () => {
    const bindings = env({ INVITE_RATE_LIMITER: binding(false) });
    const response = await worker.fetch(
      new Request("https://dont-text-your-ex.worldwidewebb.co/api/jars/preview", {
        method: "POST",
        headers: { "CF-Connecting-IP": "203.0.113.44" },
      }),
      bindings,
      {},
      vi.fn(async () => new Response("must not happen")),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "invite_rate_limited",
      retryAfterSeconds: 60,
    });
  });

  test("fails closed without reaching origin when a binding errors", async () => {
    const brokenGeneral = binding();
    brokenGeneral.limit.mockRejectedValueOnce(new Error("binding unavailable"));
    const bindings = env({ GENERAL_RATE_LIMITER: brokenGeneral });
    const origin = vi.fn(async () => new Response("must not happen"));

    const response = await worker.fetch(request("/api/me"), bindings, executionContext, origin);

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("X-DTYE-Rate-Limit-Layer")).toBe("edge-error");
    expect(await response.json()).toEqual({ error: "edge_rate_limit_unavailable" });
    expect(origin).not.toHaveBeenCalled();
  });

  test("missing or untrusted client IP fails closed and never becomes a shared key", async () => {
    const bindings = env();
    const origin = vi.fn(async () => new Response("must not happen"));
    const untrusted = new Request("https://dont-text-your-ex.worldwidewebb.co/api/me");

    const response = await worker.fetch(untrusted, bindings, executionContext, origin);

    expect(response.status).toBe(503);
    expect(origin).not.toHaveBeenCalled();
    for (const limiter of Object.values(bindings)) expect(limiter.limit).not.toHaveBeenCalled();
  });
});
