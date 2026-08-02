/**
 * Tests for device-sync-service.
 * Uses an in-memory DeviceStateStore for device_state and mocks DB (still used
 * by the shared integration-heartbeat helper for integration_sync_status) + HA.
 */
import { createInMemoryDeviceStateStore, DeviceKind, type SeedDevice } from "@www/core";
import { getLogger, resetChangeLog } from "@www/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── mock DB (only backs integration-heartbeat's integration_sync_status) ─────

const { mockDbSelect, mockDbInsert } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
}));

vi.mock("./db", async () => {
  const { createPgIntegrationSyncStore } = await import("@www/core");
  const db = {
    select: mockDbSelect,
    insert: mockDbInsert,
  };
  return {
    db,
    integrationSyncStore: createPgIntegrationSyncStore(db as never),
  };
});

// ─── mock HA ─────────────────────────────────────────────────────────────────

const { mockGetEntities } = vi.hoisted(() => ({
  mockGetEntities: vi.fn(),
}));

vi.mock("./deps", () => ({
  ha: {
    getEntities: mockGetEntities,
  },
}));

// ─── import after mocks ──────────────────────────────────────────────────────

import { reconcile, runDeviceSyncCycle, sweepExpiredWindows } from "./device-sync";

// ─── helpers ─────────────────────────────────────────────────────────────────

async function seedDevice(
  store: ReturnType<typeof createInMemoryDeviceStateStore>,
  overrides: Partial<SeedDevice> = {},
): Promise<void> {
  await store.seed({
    id: "dev-1",
    kind: DeviceKind.Light,
    entityId: "light.lamp",
    domain: "light",
    label: "Lamp",
    available: false,
    ...overrides,
  });
}

// A thenable select chain that resolves to `rows` when awaited (drizzle mock,
// only used for the heartbeat's integration_sync_status reads).
class SelectChain {
  private readonly rows: unknown[];
  constructor(rows: unknown[]) {
    this.rows = rows;
  }
  from(): this {
    return this;
  }
  where(): this {
    return this;
  }
  orderBy(): this {
    return this;
  }
  limit(): Promise<unknown[]> {
    return Promise.resolve(this.rows);
  }
  [Symbol.toStringTag] = "SelectChain";
  // biome-ignore lint/suspicious/noThenProperty: intentional thenable for drizzle mock
  then<R>(
    onFulfilled: (v: unknown[]) => R | PromiseLike<R>,
    onRejected?: (e: unknown) => R | PromiseLike<R>,
  ): Promise<R> {
    return Promise.resolve(this.rows).then(onFulfilled, onRejected);
  }
  catch<R>(onRejected: (e: unknown) => R | PromiseLike<R>): Promise<unknown[] | R> {
    return Promise.resolve(this.rows).catch(onRejected);
  }
  finally(onFinally?: (() => void) | null): Promise<unknown[]> {
    return Promise.resolve(this.rows).finally(onFinally ?? undefined);
  }
}

function makeSelectChain(rows: unknown[]): SelectChain {
  return new SelectChain(rows);
}

// ─── reconcile tests ─────────────────────────────────────────────────────────

describe("reconcile", () => {
  let store: ReturnType<typeof createInMemoryDeviceStateStore>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    store = createInMemoryDeviceStateStore();
    resetChangeLog();
    infoSpy = vi.spyOn(getLogger(), "info");
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it("updates reportedState when HA state changes", async () => {
    await seedDevice(store, { reported: { on: false }, available: true });

    const snapshot = new Map([
      ["light.lamp", { entity_id: "light.lamp", state: "on", attributes: {}, last_updated: "" }],
    ]);

    await reconcile(snapshot, store);

    const row = await store.read("dev-1");
    expect(row?.reportedState).toEqual({ on: true });
    expect(row?.available).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith(
      {
        deviceId: "dev-1",
        entityId: "light.lamp",
        reported: { on: true },
        available: true,
      },
      "device-sync observed reported state change",
    );
  });

  it("skips enforcer-managed lights , they are owned by the light enforcer (www-7d5b.2.6)", async () => {
    // A real LIGHTS entry (light.living_room_globe) must be left entirely to the
    // enforcer; device-sync must not touch its reported/available state or it
    // would double-drive the lights. Fan stays device-sync's job.
    await seedDevice(store, {
      id: "living-globe",
      entityId: "light.living_room_globe",
      reported: { on: false },
      available: true,
    });

    // HA reports the lamp ON (would normally trigger a reportedState update).
    const snapshot = new Map([
      [
        "light.living_room_globe",
        { entity_id: "light.living_room_globe", state: "on", attributes: {}, last_updated: "" },
      ],
    ]);

    await reconcile(snapshot, store);

    // No write for the managed lamp , reportedState stays what it was seeded with.
    const row = await store.read("living-globe");
    expect(row?.reportedState).toEqual({ on: false });
  });

  it("skips speaker rows , they are owned by the sonos-volume-enforcer (www-5mek)", async () => {
    // A speaker row's entityId is a LAN IP that never exists in the HA snapshot;
    // without the skip, device-sync would mark it unavailable every cycle and
    // fight the sonos-volume-enforcer.
    await seedDevice(store, {
      id: "spk_192-168-0-193",
      kind: DeviceKind.Speaker,
      entityId: "192.168.0.193",
      reported: { volume: 30 },
      desired: { volume: 30 },
      available: true,
    });

    await reconcile(new Map(), store);

    const row = await store.read("spk_192-168-0-193");
    expect(row?.available).toBe(true);
    expect(row?.reportedState).toEqual({ volume: 30 });
  });

  it("clears desiredUntilUtc early when HA state matches desiredState", async () => {
    await store.upsertDesired({
      id: "dev-1",
      kind: DeviceKind.Light,
      entityId: "light.lamp",
      domain: "light",
      label: "Lamp",
      desired: { on: true },
      windowMs: 60_000,
    });

    const snapshot = new Map([
      ["light.lamp", { entity_id: "light.lamp", state: "on", attributes: {}, last_updated: "" }],
    ]);

    await reconcile(snapshot, store);

    const row = await store.read("dev-1");
    expect(row?.desiredState).toBeNull();
    expect(row?.desiredUntilUtc).toBeNull();
    expect(infoSpy).toHaveBeenCalledWith(
      {
        deviceId: "dev-1",
        entityId: "light.lamp",
        desired: { on: true },
        reported: { on: true },
      },
      "device-sync observed desired state and cleared command window",
    );
  });

  it("stays quiet when reported state is unchanged and no command window converges", async () => {
    await seedDevice(store, { reported: { on: true }, available: true });

    const snapshot = new Map([
      ["light.lamp", { entity_id: "light.lamp", state: "on", attributes: {}, last_updated: "" }],
    ]);

    await reconcile(snapshot, store);

    expect(infoSpy).not.toHaveBeenCalled();
  });
});

// ─── sweepExpiredWindows tests ────────────────────────────────────────────────

describe("sweepExpiredWindows", () => {
  let store: ReturnType<typeof createInMemoryDeviceStateStore>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    store = createInMemoryDeviceStateStore();
    // Fresh emission per test , logChange suppresses a repeated identical
    // signature for the same key within its window (docs/logging.md §3).
    resetChangeLog();
    warnSpy = vi.spyOn(getLogger(), "warn");
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("never clears a speaker row's sticky desired , owned by the sonos-volume-enforcer (www-5mek)", async () => {
    const now = new Date();
    await store.seed({
      id: "spk_192-168-0-193",
      kind: DeviceKind.Speaker,
      entityId: "192.168.0.193",
      domain: "sonos",
      label: "Speaker",
      reported: { volume: 30 },
      available: true,
    });
    await store.upsertDesired({
      id: "spk_192-168-0-193",
      kind: DeviceKind.Speaker,
      entityId: "192.168.0.193",
      domain: "sonos",
      label: "Speaker",
      desired: { volume: 55 },
      windowMs: -1_000,
    });

    await sweepExpiredWindows(now, store);

    const row = await store.read("spk_192-168-0-193");
    expect(row?.desiredState).toEqual({ volume: 55 });
  });

  it("clears the desired window when it expires (no device_commands rows created)", async () => {
    const commandAt = new Date("2026-07-30T12:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(commandAt);

    try {
      await store.upsertDesired({
        id: "dev-1",
        kind: DeviceKind.Light,
        entityId: "light.lamp",
        domain: "light",
        label: "Lamp",
        desired: { on: true },
        windowMs: 60_000,
      });

      const sweptAt = new Date("2026-07-30T12:01:15Z");
      await sweepExpiredWindows(sweptAt, store);

      const row = await store.read("dev-1");
      expect(row?.desiredState).toBeNull();
      expect(row?.desiredUntilUtc).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        {
          deviceId: "dev-1",
          entityId: "light.lamp",
          desired: { on: true },
          elapsed: 75_000,
        },
        "command window expired, clearing desired",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── heartbeat / consecutiveFailures transitions (www-355t.9) ──────────────────

describe("runDeviceSyncCycle heartbeat", () => {
  let store: ReturnType<typeof createInMemoryDeviceStateStore>;

  beforeEach(() => {
    vi.resetAllMocks();
    store = createInMemoryDeviceStateStore();
  });

  it("resets consecutiveFailures to 0 on a successful cycle", async () => {
    mockGetEntities.mockResolvedValue([]); // empty snapshot, reconcile no-ops
    mockDbSelect.mockReturnValue(makeSelectChain([])); // currentFailureStreak()

    const insertValues = vi
      .fn()
      .mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) });
    mockDbInsert.mockReturnValue({ values: insertValues });

    await runDeviceSyncCycle(store);

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: null, consecutiveFailures: 0 }),
    );
  });

  it("increments consecutiveFailures from the prior streak on a failed cycle", async () => {
    mockGetEntities.mockRejectedValue(new Error("HA down")); // fetchSnapshot throws
    // currentFailureStreak() reads the prior row: 2 consecutive failures so far.
    mockDbSelect.mockReturnValue(makeSelectChain([{ n: 2 }]));

    const insertValues = vi
      .fn()
      .mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) });
    mockDbInsert.mockReturnValue({ values: insertValues });

    // runCycle now rethrows after recording the heartbeat (www-bd0c), so the
    // worker runtime observes the failure and drives its own onset/recovery
    // logging; the heartbeat write below is still expected to have landed.
    await expect(runDeviceSyncCycle(store)).rejects.toThrow("HA down");

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: "HA down", consecutiveFailures: 3 }),
    );
  });
});
