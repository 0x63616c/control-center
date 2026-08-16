import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activity: vi.fn(async (_input: { readonly iteration: number }) => ({ status: "ok" as const })),
  outbox: vi.fn(async () => ({ claimed: 0, accepted: 0, retried: 0, failed: 0 })),
  sessions: vi.fn(async () => ({ deleted: 0 })),
  continueAsNew: vi.fn(async (input: unknown) => input),
  prepareNotification: vi.fn(async () => ({ deliveryIds: [] })),
  deliverNotification: vi.fn(async () => ({ kind: "accepted" as const })),
  suppressNotification: vi.fn(async () => undefined),
  sleep: vi.fn(async () => undefined),
  handlers: new Map<string, (input: never) => void>(),
}));

vi.mock("@temporalio/workflow", () => ({
  condition: vi.fn(async () => false),
  defineQuery: (name: string) => name,
  defineSignal: (name: string) => name,
  proxyActivities: () => ({
    DtyeHealthCheckActivity: mocks.activity,
    OutboxDispatchActivity: mocks.outbox,
    SessionMaintenanceActivity: mocks.sessions,
    prepareNotification: mocks.prepareNotification,
    deliverNotification: mocks.deliverNotification,
    suppressNotification: mocks.suppressNotification,
  }),
  continueAsNew: mocks.continueAsNew,
  setHandler: vi.fn((name: string, handler: (input: never) => void) => {
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
  mocks.continueAsNew.mockReset().mockImplementation(async (input: unknown) => input);
  mocks.prepareNotification.mockReset().mockResolvedValue({ deliveryIds: [] });
  mocks.deliverNotification.mockReset().mockResolvedValue({ kind: "accepted" });
  mocks.suppressNotification.mockReset().mockResolvedValue(undefined);
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
