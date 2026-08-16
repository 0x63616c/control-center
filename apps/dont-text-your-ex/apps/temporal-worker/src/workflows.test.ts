import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activity: vi.fn(async (_input: { readonly iteration: number }) => ({ status: "ok" as const })),
  outbox: vi.fn(async () => ({ claimed: 0, accepted: 0, retried: 0, failed: 0 })),
  sessions: vi.fn(async () => ({ deleted: 0 })),
  continueAsNew: vi.fn(async (input: unknown) => input),
  sleep: vi.fn(async () => undefined),
}));

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => ({
    DtyeHealthCheckActivity: mocks.activity,
    OutboxDispatchActivity: mocks.outbox,
    SessionMaintenanceActivity: mocks.sessions,
  }),
  continueAsNew: mocks.continueAsNew,
  sleep: mocks.sleep,
}));

import {
  DtyeHealthCheckWorkflow,
  OutboxDispatchRecoveryWorkflow,
  SessionMaintenanceWorkflow,
} from "./workflows";

beforeEach(() => {
  mocks.activity.mockReset().mockResolvedValue({ status: "ok" });
  mocks.outbox.mockReset().mockResolvedValue({ claimed: 0, accepted: 0, retried: 0, failed: 0 });
  mocks.sessions.mockReset().mockResolvedValue({ deleted: 0 });
  mocks.continueAsNew.mockReset().mockImplementation(async (input: unknown) => input);
  mocks.sleep.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("DtyeHealthCheckWorkflow", () => {
  test("runs exactly five checks and returns the locked terminal result", async () => {
    await expect(DtyeHealthCheckWorkflow({ schemaVersion: 1 })).resolves.toEqual({
      status: "healthy",
      checks: 5,
    });
    expect(mocks.activity).toHaveBeenCalledTimes(5);
    expect(mocks.activity.mock.calls.map(([input]) => input)).toEqual([
      { iteration: 0 },
      { iteration: 1 },
      { iteration: 2 },
      { iteration: 3 },
      { iteration: 4 },
    ]);
  });

  test("rejects an incompatible input schema before running an activity", async () => {
    await expect(DtyeHealthCheckWorkflow({ schemaVersion: 2 } as never)).rejects.toThrow(
      "unsupported health workflow schema",
    );
    expect(mocks.activity).not.toHaveBeenCalled();
  });
});

describe("OutboxDispatchRecoveryWorkflow", () => {
  test("rejects an incompatible schema before claiming events", async () => {
    await expect(OutboxDispatchRecoveryWorkflow({ schemaVersion: 2 } as never)).rejects.toThrow(
      "unsupported outbox recovery workflow schema",
    );
    expect(mocks.outbox).not.toHaveBeenCalled();
  });
});

describe("SessionMaintenanceWorkflow", () => {
  test("rejects an incompatible schema before deleting sessions", async () => {
    await expect(SessionMaintenanceWorkflow({ schemaVersion: 2 } as never)).rejects.toThrow(
      "unsupported session maintenance workflow schema",
    );
    expect(mocks.sessions).not.toHaveBeenCalled();
  });

  test("preserves the original purge cutoff across continue-as-new", async () => {
    mocks.sessions.mockResolvedValue({ deleted: 500 });
    mocks.continueAsNew.mockImplementationOnce(async (input: unknown) => Promise.reject(input));
    vi.spyOn(Date, "now").mockReturnValue(123_456);

    await expect(SessionMaintenanceWorkflow({ schemaVersion: 1 })).rejects.toEqual({
      schemaVersion: 1,
      deleted: 10_000,
      runs: 1,
      purgeBefore: 123_456,
    });

    expect(mocks.sessions).toHaveBeenCalledTimes(20);
    expect(mocks.sessions).toHaveBeenCalledWith({ now: 123_456, limit: 500 });
    expect(mocks.continueAsNew).toHaveBeenCalledWith({
      schemaVersion: 1,
      deleted: 10_000,
      runs: 1,
      purgeBefore: 123_456,
    });
  });
});
