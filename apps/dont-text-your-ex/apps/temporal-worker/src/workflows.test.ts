import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activity: vi.fn(async (_input: { readonly iteration: number }) => ({ status: "ok" as const })),
  outbox: vi.fn(async () => ({ claimed: 0, accepted: 0, retried: 0, failed: 0 })),
  sessions: vi.fn(async () => ({ deleted: 0 })),
  streaks: vi.fn(async (_input: { readonly cutoff: number; readonly cursor?: string }) => ({
    candidates: 0,
    achievements: 0,
    notifications: 0,
    sharedActivities: 0,
    hasMore: false,
  })),
  continueAsNew: vi.fn(async (input: unknown) => input),
  prepareNotification: vi.fn(async () => ({ deliveryIds: [] })),
  deliverNotification: vi.fn(async () => ({ kind: "accepted" as const })),
  suppressNotification: vi.fn(async () => undefined),
  report: vi.fn(),
  condition: vi.fn(async (_predicate: () => boolean, _timeout?: number) => false),
  now: { value: 0 },
  sleep: vi.fn(async () => undefined),
  handlers: new Map<string, (input: unknown) => void>(),
}));

vi.mock("@temporalio/workflow", () => ({
  condition: mocks.condition,
  defineQuery: (name: string) => name,
  defineSignal: (name: string) => name,
  proxyActivities: () => ({
    DtyeHealthCheckActivity: mocks.activity,
    OutboxDispatchActivity: mocks.outbox,
    SessionMaintenanceActivity: mocks.sessions,
    StreakMilestoneSweepActivity: mocks.streaks,
    prepareNotification: mocks.prepareNotification,
    deliverNotification: mocks.deliverNotification,
    suppressNotification: mocks.suppressNotification,
    ReportAccountabilityActivity: mocks.report,
  }),
  continueAsNew: mocks.continueAsNew,
  setHandler: vi.fn((name: string, handler: (input: unknown) => void) => {
    mocks.handlers.set(name, handler);
  }),
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
  mocks.streaks.mockReset().mockResolvedValue({
    candidates: 0,
    achievements: 0,
    notifications: 0,
    sharedActivities: 0,
    hasMore: false,
  });
  mocks.continueAsNew.mockReset().mockImplementation(async (input: unknown) => input);
  mocks.prepareNotification.mockReset().mockResolvedValue({ deliveryIds: [] });
  mocks.deliverNotification.mockReset().mockResolvedValue({ kind: "accepted" });
  mocks.suppressNotification.mockReset().mockResolvedValue(undefined);
  mocks.report.mockReset();
  mocks.condition.mockReset().mockImplementation(async (_predicate: () => boolean, timeout) => {
    mocks.now.value += timeout ?? 0;
    return false;
  });
  mocks.handlers.clear();
  mocks.now.value = 0;
  vi.spyOn(Date, "now").mockImplementation(() => mocks.now.value);
  mocks.sleep.mockReset().mockResolvedValue(undefined);
  mocks.handlers.clear();
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

describe("StreakMilestoneSweepWorkflow", () => {
  test("rejects an incompatible schema before scanning memberships", async () => {
    const { StreakMilestoneSweepWorkflow } = await import("./workflows");
    await expect(StreakMilestoneSweepWorkflow({ schemaVersion: 2 } as never)).rejects.toThrow(
      "unsupported streak sweep workflow schema",
    );
    expect(mocks.streaks).not.toHaveBeenCalled();
  });

  test("uses a stable cutoff and continues deterministic pages as new", async () => {
    const { StreakMilestoneSweepWorkflow } = await import("./workflows");
    vi.spyOn(Date, "now").mockReturnValue(1_754_231_400_000);
    mocks.streaks.mockImplementation(async ({ cursor }: { cursor?: string }) => ({
      candidates: 100,
      achievements: 1,
      notifications: 1,
      sharedActivities: 0,
      nextCursor: `${cursor ?? "member"}x`,
      hasMore: true,
    }));
    mocks.continueAsNew.mockImplementationOnce(async (input: unknown) => Promise.reject(input));

    await expect(StreakMilestoneSweepWorkflow({ schemaVersion: 1 })).rejects.toMatchObject({
      schemaVersion: 1,
      cutoff: 1_754_231_400_000,
      totals: {
        candidates: 2_000,
        achievements: 20,
        notifications: 20,
        sharedActivities: 0,
      },
      runs: 1,
    });
    expect(mocks.streaks).toHaveBeenCalledTimes(20);
    expect(mocks.streaks.mock.calls.every(([input]) => input.cutoff === 1_754_231_400_000)).toBe(
      true,
    );
  });
});

describe("NotificationDeliveryWorkflow", () => {
  test("accepts only the exact opaque notification input and returns terminal outcomes", async () => {
    const { NotificationDeliveryWorkflow } = await import("./workflows");
    mocks.prepareNotification.mockResolvedValue({
      deliveryIds: ["ndl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] as never,
    });

    await expect(
      NotificationDeliveryWorkflow({
        schemaVersion: 1,
        notificationId: "ntf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      } as never),
    ).resolves.toEqual({
      notificationId: "ntf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      deliveryCount: 1,
      outcomes: ["delivered"],
    });
    expect(mocks.deliverNotification).toHaveBeenCalledWith({
      deliveryId: "ndl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      finalAttempt: false,
    });

    await expect(
      NotificationDeliveryWorkflow({ schemaVersion: 1, aggregateId: "usr_private" } as never),
    ).rejects.toThrow();
  });

  test("preserves an already persisted delivered outcome after activity replay", async () => {
    const { NotificationDeliveryWorkflow } = await import("./workflows");
    mocks.prepareNotification.mockResolvedValue({
      deliveryIds: ["ndl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] as never,
    });
    mocks.deliverNotification.mockResolvedValue({
      kind: "already_terminal",
      state: "delivered",
    } as never);

    await expect(
      NotificationDeliveryWorkflow({
        schemaVersion: 1,
        notificationId: "ntf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      } as never),
    ).resolves.toMatchObject({ outcomes: ["delivered"] });
  });

  test("accepts only a matching, monotonic account-deletion signal", async () => {
    const { NotificationDeliveryWorkflow } = await import("./workflows");
    mocks.prepareNotification.mockImplementation(async () => {
      const signal = mocks.handlers.get("accountDeleted");
      signal?.({
        schemaVersion: 1,
        notificationId: "ntf_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        expectedAggregateVersion: 1,
      } as never);
      return { deliveryIds: ["ndl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] as never };
    });

    await expect(
      NotificationDeliveryWorkflow({
        schemaVersion: 1,
        notificationId: "ntf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      } as never),
    ).resolves.toMatchObject({ outcomes: ["delivered"] });
    expect(mocks.deliverNotification).toHaveBeenCalledOnce();

    mocks.prepareNotification.mockImplementation(async () => {
      const signal = mocks.handlers.get("accountDeleted");
      signal?.({
        schemaVersion: 1,
        notificationId: "ntf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expectedAggregateVersion: 1,
      } as never);
      return { deliveryIds: ["ndl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] as never };
    });
    mocks.deliverNotification.mockClear();

    await expect(
      NotificationDeliveryWorkflow({
        schemaVersion: 1,
        notificationId: "ntf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      } as never),
    ).resolves.toMatchObject({ outcomes: ["suppressed"] });
    expect(mocks.deliverNotification).not.toHaveBeenCalled();
    expect(mocks.suppressNotification).toHaveBeenCalledWith({
      notificationId: "ntf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });
});

describe("ReportAccountabilityWorkflow", () => {
  const reportId = "rpt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const pending = (createdAt = 0) => ({
    state: "pending" as const,
    reportId,
    aggregateVersion: 1,
    createdAt,
  });

  test("time-skips through immediate, 24-hour, 72-hour and seven-day expiry", async () => {
    const { ReportAccountabilityWorkflow } = await import("./workflows");
    mocks.report.mockImplementation(async (input: { action: string }) =>
      input.action === "expire" ? { state: "expired", reportId, aggregateVersion: 2 } : pending(),
    );

    await expect(
      ReportAccountabilityWorkflow({ schemaVersion: 1, reportId } as never),
    ).resolves.toEqual({ schemaVersion: 1, reportId, aggregateVersion: 2, state: "expired" });
    expect(mocks.report.mock.calls.map(([input]) => input.action)).toEqual([
      "inspect",
      "remind_immediate",
      "remind_24h",
      "remind_72h",
      "expire",
    ]);
    expect(mocks.now.value).toBe(7 * 86_400_000);
  });

  test("expires an already-old backfill without historical reminders", async () => {
    const { ReportAccountabilityWorkflow } = await import("./workflows");
    mocks.now.value = 8 * 86_400_000;
    mocks.report
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce({ state: "expired", reportId, aggregateVersion: 2 });

    await ReportAccountabilityWorkflow({ schemaVersion: 1, reportId } as never);
    expect(mocks.report.mock.calls.map(([input]) => input.action)).toEqual(["inspect", "expire"]);
    expect(mocks.condition).not.toHaveBeenCalled();
  });

  test.each([
    ["owned", "owned"],
    ["denied", "denied"],
    ["jarClosed", "jar_closed"],
    ["memberDeparted", "member_departed"],
    ["accountDeleted", "account_deleted"],
  ] as const)("ends on the authoritative %s signal", async (signalName, terminalState) => {
    const { ReportAccountabilityWorkflow } = await import("./workflows");
    mocks.report
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce({ state: terminalState, reportId, aggregateVersion: 2 });
    mocks.condition.mockImplementationOnce(async () => {
      const handler = mocks.handlers.get(signalName);
      if (!handler) throw new Error(`missing ${signalName} handler`);
      handler({ schemaVersion: 1, reportId, expectedAggregateVersion: 2 });
      return true;
    });

    await expect(
      ReportAccountabilityWorkflow({ schemaVersion: 1, reportId } as never),
    ).resolves.toMatchObject({ state: terminalState, aggregateVersion: 2 });
    expect(mocks.report).toHaveBeenLastCalledWith({
      reportId,
      action: "inspect",
      expectedAggregateVersion: 2,
    });
  });
});
