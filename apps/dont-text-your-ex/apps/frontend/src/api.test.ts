import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JarIdSchema, ReportIdSchema, RescueInterventionIdSchema } from "../../../contracts";
import { api, inviteRetryAfterSeconds, isApiErrorStatus } from "./api";

describe("frontend response JSON boundary", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a successful response that does not match its endpoint contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([{ id: "usr_wrong-domain" }])),
    );

    await expect(api.jars()).rejects.toThrow("invalid response for GET /jars");
  });

  it("does not expose an invalid error payload as trusted API detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 42 }), {
            status: 400,
            statusText: "Bad Request",
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const request = api.me();
    await expect(request).rejects.toMatchObject({
      status: 400,
      message: "Bad Request",
      detail: undefined,
    });
  });

  it("identifies only API failures with the requested HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "not_authenticated" }, { status: 401 })),
    );

    const error = await api.me().catch((caught: unknown) => caught);
    expect(isApiErrorStatus(error, 401)).toBe(true);
    expect(isApiErrorStatus(error, 500)).toBe(false);
    expect(isApiErrorStatus(new Error("network unavailable"), 401)).toBe(false);
  });

  it("exposes a typed retry delay only for invite rate limits", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "invite_rate_limited", retryAfterSeconds: 47 }, { status: 429 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await api.jarByCode("XEX24K").catch((caught: unknown) => caught);
    expect(inviteRetryAfterSeconds(error)).toBe(47);
    expect(inviteRetryAfterSeconds(new Error("network unavailable"))).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/jars/preview",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ code: "XEX24K" }) }),
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("/jars/code/XEX24K");
  });

  it("routes branded jar and report identifiers to their matching resources", async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.jar(JarIdSchema.parse("jar_123"))).rejects.toThrow(
      "invalid response for GET /jars/jar_123",
    );
    await expect(api.resolveReport(ReportIdSchema.parse("rpt_123"), "deny")).rejects.toThrow(
      "invalid response for POST /reports/rpt_123/resolve",
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/jars/jar_123",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/reports/rpt_123/resolve",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses the authenticated rescue resources and validates every returned state", async () => {
    const intervention = {
      id: "rsi_0123456789abcdef0123456789abcdef",
      status: "active",
      startedAt: 1_750_000_000_000,
      deadlineAt: 1_750_000_600_000,
      extensionCount: 0,
      aggregateVersion: 1,
      updatedAt: 1_750_000_000_000,
    };
    const fetchMock = vi.fn(async () => Response.json(intervention));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.currentRescue()).resolves.toMatchObject({ status: "active" });
    await expect(api.startRescue()).resolves.toMatchObject({ status: "active" });
    await expect(
      api.rescueCommand(RescueInterventionIdSchema.parse(intervention.id), "extend"),
    ).resolves.toMatchObject({ status: "active" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/rescue",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/rescue",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `/api/rescue/${intervention.id}/command`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "extend" }) }),
    );
  });
});
