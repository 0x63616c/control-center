/**
 * Tests for the party engine + reconcilePartyMode worker (www-7d5b.3.3).
 *
 * The reconcile decision is a PURE function (decidePartyAction) tested directly.
 * The engine's tick (which drives HA) is tested via its pure color/param build;
 * a cycle-level test stubs the engine to prove reconcile drives start/stop.
 */
import { createInMemoryDeviceStateStore, DeviceKind, type DeviceStateStore } from "@www/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// device-state reads now go through the injected DeviceStateStore; `db` still
// backs the lamp_mode singleton table (unrelated to the device_state migration).
const { mockDbSelect } = vi.hoisted(() => ({ mockDbSelect: vi.fn() }));
vi.mock("./db", () => ({ db: { select: mockDbSelect } }));

const { mockCallService } = vi.hoisted(() => ({ mockCallService: vi.fn() }));
vi.mock("./deps", () => ({ ha: { callService: mockCallService } }));

import { LampMode, LampModeSpeed } from "./lamp-scenes";
import { decidePartyAction, partyTurnOnParams } from "./party";

// ─── pure tick → HA params ─────────────────────────────────────────────────────

describe("partyTurnOnParams", () => {
  it("builds light.turn_on params with rgb + transition for a lamp", () => {
    const params = partyTurnOnParams("light.desk", [0, 255, 0], LampModeSpeed.Medium);
    expect(params).toEqual({ entity_id: "light.desk", rgb_color: [0, 255, 0], transition: 7 });
  });
});

// ─── pure reconcile decision ────────────────────────────────────────────────────

describe("decidePartyAction", () => {
  it("starts when mode=party, a lamp is on, and the engine is not running", () => {
    const d = decidePartyAction(
      { mode: LampMode.Party, speed: LampModeSpeed.Fast },
      { anyLampOn: true },
      { running: false, speed: null },
    );
    expect(d).toEqual({ kind: "start", speed: LampModeSpeed.Fast });
  });

  it("does nothing when already running at the same speed", () => {
    const d = decidePartyAction(
      { mode: LampMode.Party, speed: LampModeSpeed.Fast },
      { anyLampOn: true },
      { running: true, speed: LampModeSpeed.Fast },
    );
    expect(d).toEqual({ kind: "noop" });
  });

  it("restarts when the speed changed while running", () => {
    const d = decidePartyAction(
      { mode: LampMode.Party, speed: LampModeSpeed.Slow },
      { anyLampOn: true },
      { running: true, speed: LampModeSpeed.Fast },
    );
    expect(d).toEqual({ kind: "start", speed: LampModeSpeed.Slow });
  });

  it("stops when mode is none", () => {
    const d = decidePartyAction(
      { mode: LampMode.None, speed: null },
      { anyLampOn: true },
      { running: true, speed: LampModeSpeed.Fast },
    );
    expect(d).toEqual({ kind: "stop" });
  });

  it("stops when all lamps are off even if mode=party", () => {
    const d = decidePartyAction(
      { mode: LampMode.Party, speed: LampModeSpeed.Fast },
      { anyLampOn: false },
      { running: true, speed: LampModeSpeed.Fast },
    );
    expect(d).toEqual({ kind: "stop" });
  });

  it("does not start when mode=party but no lamp is on", () => {
    const d = decidePartyAction(
      { mode: LampMode.Party, speed: LampModeSpeed.Fast },
      { anyLampOn: false },
      { running: false, speed: null },
    );
    expect(d).toEqual({ kind: "noop" });
  });

  it("defaults a missing/invalid speed to Medium when starting", () => {
    const d = decidePartyAction(
      { mode: LampMode.Party, speed: null },
      { anyLampOn: true },
      { running: false, speed: null },
    );
    expect(d).toEqual({ kind: "start", speed: LampModeSpeed.Medium });
  });
});

// ─── reconcile cycle with injected (stubbed) engine ────────────────────────────

import type { PartyEngine } from "./party";
import { reconcilePartyMode } from "./party";

class Chain {
  constructor(private readonly rows: unknown[]) {}
  from() {
    return this;
  }
  where() {
    return this;
  }
  limit(): Promise<unknown[]> {
    return Promise.resolve(this.rows);
  }
  [Symbol.toStringTag] = "Chain";
  // biome-ignore lint/suspicious/noThenProperty: thenable drizzle mock
  then<R>(onFulfilled: (v: unknown[]) => R | PromiseLike<R>): Promise<R> {
    return Promise.resolve(this.rows).then(onFulfilled);
  }
}

function stubEngine(running = false, speed: LampModeSpeed | null = null): PartyEngine {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    status: () => ({ running, speed }),
  };
}

let store: DeviceStateStore;

beforeEach(() => {
  vi.clearAllMocks();
  mockCallService.mockResolvedValue(undefined);
  store = createInMemoryDeviceStateStore();
});

async function seedLamp(desiredOn: boolean): Promise<void> {
  await store.upsertDesired({
    id: "lgt_desk",
    kind: DeviceKind.Light,
    entityId: "light.desk",
    domain: "light",
    label: "Desk",
    desired: { on: desiredOn },
  });
}

describe("reconcilePartyMode", () => {
  it("starts the engine when the DB row says party and a lamp is on", async () => {
    const eng = stubEngine(false, null);
    mockDbSelect.mockReturnValueOnce(
      new Chain([{ id: "singleton", mode: "party", speed: "fast" }]),
    );
    await seedLamp(true);

    await reconcilePartyMode(eng, store);

    expect(eng.start).toHaveBeenCalledWith(LampModeSpeed.Fast);
    expect(eng.stop).not.toHaveBeenCalled();
  });

  it("stops the engine when the DB row says none", async () => {
    const eng = stubEngine(true, LampModeSpeed.Fast);
    mockDbSelect.mockReturnValueOnce(new Chain([{ id: "singleton", mode: "none", speed: null }]));
    await seedLamp(true);

    await reconcilePartyMode(eng, store);

    expect(eng.stop).toHaveBeenCalled();
    expect(eng.start).not.toHaveBeenCalled();
  });

  it("stops the engine when all lamps are off", async () => {
    const eng = stubEngine(true, LampModeSpeed.Fast);
    mockDbSelect.mockReturnValueOnce(
      new Chain([{ id: "singleton", mode: "party", speed: "fast" }]),
    );
    await seedLamp(false);

    await reconcilePartyMode(eng, store);

    expect(eng.stop).toHaveBeenCalled();
  });
});
