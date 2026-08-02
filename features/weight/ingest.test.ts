import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Chainable select/update/insert mocks, matching the pattern used by
// asc-version-service.test.ts / weather-ingest-service.test.ts. Each mock
// object is "thenable" so `await db.select()...where()` resolves regardless
// of whether `.limit()` was chained on top.
const captured = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  updateQueue: [] as unknown[][],
  updateCalls: [] as Record<string, unknown>[],
  insertCalls: [] as Record<string, unknown>[],
}));

// Real Promise (not a plain object with a custom `then`) with chain methods
// bolted on via Object.assign, so `await db.select()...where()` resolves
// correctly whether or not `.limit()` was chained on top , and the linter's
// noThenProperty rule (this isn't a thenable-by-accident) stays clean.
function makeChainable(getResult: () => unknown) {
  const chain = Object.assign(Promise.resolve().then(getResult), {
    from: () => chain,
    where: () => chain,
    limit: () => chain,
  });
  return chain;
}

vi.mock("./db", () => ({
  db: {
    select: () => makeChainable(() => captured.selectQueue.shift() ?? []),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        captured.updateCalls.push(values);
        return {
          where: () =>
            Object.assign(Promise.resolve(undefined), {
              returning: () => Promise.resolve(captured.updateQueue.shift() ?? []),
            }),
        };
      },
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        captured.insertCalls.push(row);
        return { onConflictDoUpdate: () => Promise.resolve(undefined) };
      },
    }),
  },
}));

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@www/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@www/core")>()),
  enqueueNotification: notifyMock,
}));

const withingsMock = vi.hoisted(() => ({
  isConfigured: vi.fn(() => true),
  refreshToken: vi.fn(),
  getMeasurementsSince: vi.fn(),
}));
vi.mock("./deps", () => ({ withings: withingsMock }));

import { runWithingsWeightIngestCycle } from "./ingest";

const VALID_TOKEN_ROW = {
  id: "singleton",
  accessToken: "access_1",
  refreshToken: "refresh_1",
  accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000), // 1h out, not near expiry
  withingsUserId: "12345",
  lastMeasUpdate: 100,
  updatedAt: new Date(),
};

beforeEach(() => {
  captured.selectQueue.length = 0;
  captured.updateQueue.length = 0;
  captured.updateCalls.length = 0;
  captured.insertCalls.length = 0;
  withingsMock.isConfigured.mockReturnValue(true);
  notifyMock.mockReset();
  notifyMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runWithingsWeightIngestCycle , guards", () => {
  it("no-ops when withings is unconfigured", async () => {
    withingsMock.isConfigured.mockReturnValue(false);
    await runWithingsWeightIngestCycle();
    expect(withingsMock.getMeasurementsSince).not.toHaveBeenCalled();
  });

  it("no-ops when no token row exists yet (pre-runbook state)", async () => {
    captured.selectQueue.push([]); // token select returns nothing
    await runWithingsWeightIngestCycle();
    expect(withingsMock.getMeasurementsSince).not.toHaveBeenCalled();
  });
});

describe("runWithingsWeightIngestCycle , token refresh", () => {
  it("does not refresh when the cached token is still valid", async () => {
    captured.selectQueue.push([VALID_TOKEN_ROW]);
    withingsMock.getMeasurementsSince.mockResolvedValue([]);
    await runWithingsWeightIngestCycle();
    expect(withingsMock.refreshToken).not.toHaveBeenCalled();
    expect(withingsMock.getMeasurementsSince).toHaveBeenCalledWith("access_1", 100);
  });

  it("refreshes and persists the rotated pair when near expiry", async () => {
    const expiring = { ...VALID_TOKEN_ROW, accessTokenExpiresAt: new Date(Date.now() + 1_000) };
    captured.selectQueue.push([expiring]);
    captured.updateQueue.push([{ id: "singleton" }]); // optimistic lock succeeds
    withingsMock.refreshToken.mockResolvedValue({
      accessToken: "access_2",
      refreshToken: "refresh_2",
      expiresAt: new Date(Date.now() + 10_800_000),
      withingsUserId: "12345",
    });
    withingsMock.getMeasurementsSince.mockResolvedValue([]);

    await runWithingsWeightIngestCycle();

    expect(withingsMock.refreshToken).toHaveBeenCalledWith("refresh_1");
    expect(captured.updateCalls[0]).toMatchObject({
      accessToken: "access_2",
      refreshToken: "refresh_2",
    });
    expect(withingsMock.getMeasurementsSince).toHaveBeenCalledWith("access_2", 100);
  });

  it("throws when the optimistic lock loses a race (concurrent rotation)", async () => {
    const expiring = { ...VALID_TOKEN_ROW, accessTokenExpiresAt: new Date(Date.now() + 1_000) };
    captured.selectQueue.push([expiring]);
    captured.updateQueue.push([]); // zero rows affected: someone else rotated first
    withingsMock.refreshToken.mockResolvedValue({
      accessToken: "access_2",
      refreshToken: "refresh_2",
      expiresAt: new Date(Date.now() + 10_800_000),
      withingsUserId: "12345",
    });

    await expect(runWithingsWeightIngestCycle()).rejects.toThrow(/optimistic lock/);
    expect(withingsMock.getMeasurementsSince).not.toHaveBeenCalled();
  });
});

describe("runWithingsWeightIngestCycle , measurement ingest", () => {
  it("inserts a new reading, publishes one notification, and advances the cursor", async () => {
    captured.selectQueue.push([VALID_TOKEN_ROW]); // token
    captured.selectQueue.push([]); // no existing row for this grpid
    captured.selectQueue.push([]); // no recent readings (sanity band inactive < 3 readings)
    captured.updateQueue.push([]); // cursor update (no .returning used, ignored)
    const measuredAt = new Date("2026-07-25T12:00:00Z");
    withingsMock.getMeasurementsSince.mockResolvedValue([
      { grpid: 42, date: measuredAt, weightKg: 70.3, bodyMetrics: null },
    ]);

    await runWithingsWeightIngestCycle();

    expect(captured.insertCalls).toHaveLength(1);
    expect(captured.insertCalls[0]).toMatchObject({
      weightKg: 70.3,
      source: "withings_api",
      withingsGrpid: "42",
      excludedReason: null,
    });
    expect(notifyMock).toHaveBeenCalledWith(expect.anything(), {
      category: "home",
      severity: "info",
      title: "New weight logged: 155.0lbs",
      body: "",
      dedupeKey: "withings-weight-42",
    });
    const cursorUpdate = captured.updateCalls.find((c) => "lastMeasUpdate" in c);
    expect(cursorUpdate?.lastMeasUpdate).toBe(Math.floor(measuredAt.getTime() / 1000));
  });

  it("does not notify when the row already existed (a correction, not a new reading)", async () => {
    captured.selectQueue.push([VALID_TOKEN_ROW]); // token
    captured.selectQueue.push([{ id: "wm_existing" }]); // existing row for this grpid
    captured.selectQueue.push([]); // recent readings for sanity band
    captured.updateQueue.push([]);
    withingsMock.getMeasurementsSince.mockResolvedValue([
      { grpid: 42, date: new Date(), weightKg: 70.5, bodyMetrics: null },
    ]);

    await runWithingsWeightIngestCycle();

    expect(captured.insertCalls).toHaveLength(1); // still upserts
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("a notify failure does not fail the cycle", async () => {
    captured.selectQueue.push([VALID_TOKEN_ROW]);
    captured.selectQueue.push([]);
    captured.selectQueue.push([]);
    captured.updateQueue.push([]);
    notifyMock.mockRejectedValue(new Error("apns down"));
    withingsMock.getMeasurementsSince.mockResolvedValue([
      { grpid: 1, date: new Date(), weightKg: 70, bodyMetrics: null },
    ]);

    await expect(runWithingsWeightIngestCycle()).resolves.toBeUndefined();
  });

  it("skips groups with no weight (body-comp-only entries)", async () => {
    captured.selectQueue.push([VALID_TOKEN_ROW]);
    withingsMock.getMeasurementsSince.mockResolvedValue([
      { grpid: 1, date: new Date(), weightKg: null, bodyMetrics: { fat_ratio_percent: 18 } },
    ]);

    await runWithingsWeightIngestCycle();

    expect(captured.insertCalls).toHaveLength(0);
  });

  it("does nothing when there are no new groups", async () => {
    captured.selectQueue.push([VALID_TOKEN_ROW]);
    withingsMock.getMeasurementsSince.mockResolvedValue([]);

    await runWithingsWeightIngestCycle();

    expect(captured.insertCalls).toHaveLength(0);
    expect(captured.updateCalls).toHaveLength(0);
  });
});
