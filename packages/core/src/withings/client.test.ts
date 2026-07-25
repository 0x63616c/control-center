/**
 * Unit tests for WithingsClient. All network calls are stubbed , tests never
 * reach the Withings API. No test asserts against a real-looking token value
 * beyond structural shape (obviously-fake fixture strings only).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WithingsClient, WithingsError } from "./index";

const VALID_CREDS = { clientId: "test_client_id", clientSecret: "test_client_secret" };

function oauthResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      status: 0,
      body: {
        userid: "12345",
        access_token: "test_access_token",
        refresh_token: "test_refresh_token_rotated",
        scope: "user.metrics",
        expires_in: 10800,
        token_type: "Bearer",
        ...overrides,
      },
    }),
    { status: 200 },
  );
}

function getMeasResponse(measuregrps: unknown[]): Response {
  return new Response(JSON.stringify({ status: 0, body: { measuregrps } }), { status: 200 });
}

describe("WithingsClient , isConfigured", () => {
  it("false when clientId is empty", () => {
    expect(new WithingsClient({ clientId: "", clientSecret: "secret" }).isConfigured()).toBe(false);
  });

  it("false when clientSecret is empty", () => {
    expect(new WithingsClient({ clientId: "id", clientSecret: "" }).isConfigured()).toBe(false);
  });

  it("true when both are present", () => {
    expect(new WithingsClient(VALID_CREDS).isConfigured()).toBe(true);
  });
});

describe("WithingsClient , refreshToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws WithingsError when unconfigured", async () => {
    const client = new WithingsClient({ clientId: "", clientSecret: "" });
    await expect(client.refreshToken("r")).rejects.toBeInstanceOf(WithingsError);
  });

  it("returns the rotated pair on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(oauthResponse()));
    const client = new WithingsClient(VALID_CREDS);
    const pair = await client.refreshToken("old_refresh_token");
    expect(pair.accessToken).toBe("test_access_token");
    expect(pair.refreshToken).toBe("test_refresh_token_rotated");
    expect(pair.withingsUserId).toBe("12345");
    expect(pair.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("throws WithingsError on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const client = new WithingsClient(VALID_CREDS);
    await expect(client.refreshToken("r")).rejects.toBeInstanceOf(WithingsError);
  });

  it("throws WithingsError on non-2xx HTTP", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    const client = new WithingsClient(VALID_CREDS);
    await expect(client.refreshToken("r")).rejects.toBeInstanceOf(WithingsError);
  });

  // Withings always answers HTTP 200; a non-zero in-body status is the real
  // error signal , this is the case a naive Spotify-style copy would miss.
  it("throws WithingsError when HTTP 200 but body status is non-zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 401, error: "invalid_grant" }), {
          status: 200,
        }),
      ),
    );
    const client = new WithingsClient(VALID_CREDS);
    await expect(client.refreshToken("r")).rejects.toBeInstanceOf(WithingsError);
  });
});

describe("WithingsClient , getMeasurementsSince", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scales weight by value * 10^unit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        getMeasResponse([
          {
            grpid: 1,
            date: 1_700_000_000,
            category: 1,
            measures: [{ value: 703, type: 1, unit: -1 }],
          },
        ]),
      ),
    );
    const client = new WithingsClient(VALID_CREDS);
    const groups = await client.getMeasurementsSince("token", 0);
    expect(groups).toHaveLength(1);
    expect(groups[0].weightKg).toBeCloseTo(70.3);
    expect(groups[0].grpid).toBe(1);
  });

  it("folds non-weight meastypes into bodyMetrics, leaves weight-only groups' bodyMetrics null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        getMeasResponse([
          {
            grpid: 2,
            date: 1_700_000_100,
            category: 1,
            measures: [
              { value: 700, type: 1, unit: -1 }, // weight 70.0kg
              { value: 180, type: 6, unit: -1 }, // fat_ratio 18.0%
            ],
          },
          {
            grpid: 3,
            date: 1_700_000_200,
            category: 1,
            measures: [{ value: 705, type: 1, unit: -1 }],
          },
        ]),
      ),
    );
    const client = new WithingsClient(VALID_CREDS);
    const groups = await client.getMeasurementsSince("token", 0);
    const withMetrics = groups.find((g) => g.grpid === 2);
    const withoutMetrics = groups.find((g) => g.grpid === 3);
    expect(withMetrics?.bodyMetrics).toEqual({ fat_ratio_percent: 18 });
    expect(withoutMetrics?.bodyMetrics).toBeNull();
  });

  it("returns groups sorted ascending by date", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        getMeasResponse([
          { grpid: 2, date: 200, category: 1, measures: [{ value: 700, type: 1, unit: -1 }] },
          { grpid: 1, date: 100, category: 1, measures: [{ value: 690, type: 1, unit: -1 }] },
        ]),
      ),
    );
    const client = new WithingsClient(VALID_CREDS);
    const groups = await client.getMeasurementsSince("token", 0);
    expect(groups.map((g) => g.grpid)).toEqual([1, 2]);
  });

  it("throws WithingsError on non-2xx HTTP", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const client = new WithingsClient(VALID_CREDS);
    await expect(client.getMeasurementsSince("token", 0)).rejects.toBeInstanceOf(WithingsError);
  });

  it("throws WithingsError when HTTP 200 but body status is non-zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 503 }), { status: 200 })),
    );
    const client = new WithingsClient(VALID_CREDS);
    await expect(client.getMeasurementsSince("token", 0)).rejects.toBeInstanceOf(WithingsError);
  });

  it("throws WithingsError on a malformed response (zod boundary)", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ status: 0, body: {} }), { status: 200 })),
    );
    const client = new WithingsClient(VALID_CREDS);
    await expect(client.getMeasurementsSince("token", 0)).rejects.toThrow();
  });
});

describe("WithingsError", () => {
  it("is an instance of Error", () => {
    const err = new WithingsError("test error");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("WithingsError");
    expect(err.message).toBe("test error");
  });
});
