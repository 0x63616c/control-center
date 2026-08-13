/**
 * Tests for the DB-authoritative light enforcer (www-7d5b.2.3).
 *
 * The reconcile decision is a PURE function (decideEnforcement) so the
 * seed/enforce/adopt/unreachable/tolerance matrix is tested directly without
 * mocking DB+HA chains. A couple of cycle-level tests then mock db+ha to prove
 * the decisions are executed (DB writes / HA calls) only on the right branches.
 */
import { createInMemoryDeviceStateStore, DeviceKind } from "@www/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── mock DB (only the tables the enforcer still touches directly: lampMode for
// isPartyActive, integrationSyncStatus for the heartbeat , device_state now
// goes through an in-memory DeviceStateStore, not this mock) ──────────────────

const { mockDbSelect, mockDbInsert } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
}));

vi.mock("./db", () => ({
  db: { select: mockDbSelect, insert: mockDbInsert },
  integrationSyncStore: {
    recordOk: vi.fn().mockResolvedValue(undefined),
    recordFail: vi.fn().mockResolvedValue(1),
  },
}));

// ─── mock HA ─────────────────────────────────────────────────────────────────

const { mockGetEntities, mockCallService } = vi.hoisted(() => ({
  mockGetEntities: vi.fn(),
  mockCallService: vi.fn(),
}));

vi.mock("./deps", () => ({
  ha: { getEntities: mockGetEntities, callService: mockCallService },
}));

import { type DeviceLightState, integrationSyncStatus, LightControl } from "@www/core";
import { decideEnforcement, lightStateConverged, runEnforcerCycle } from "./light-enforcer";
import { lampMode } from "./schema";

// ─── tolerant convergence compare ─────────────────────────────────────────────

describe("lightStateConverged (drift tolerance)", () => {
  it("treats small HA rgb round-trip drift as converged", () => {
    // HA round-trips [0,0,255] -> [0,2,254]; within per-channel tolerance.
    expect(
      lightStateConverged(
        { on: true, color: { rgb: [0, 0, 255] } },
        { on: true, color: { rgb: [0, 2, 254] } },
      ),
    ).toBe(true);
  });

  it("flags a real rgb change as diverged", () => {
    expect(
      lightStateConverged(
        { on: true, color: { rgb: [255, 0, 0] } },
        { on: true, color: { rgb: [0, 0, 255] } },
      ),
    ).toBe(false);
  });

  it("tolerates small kelvin drift but flags a large one", () => {
    expect(
      lightStateConverged(
        { on: true, color: { kelvin: 4000 } },
        { on: true, color: { kelvin: 4100 } },
      ),
    ).toBe(true);
    expect(
      lightStateConverged(
        { on: true, color: { kelvin: 4000 } },
        { on: true, color: { kelvin: 5000 } },
      ),
    ).toBe(false);
  });

  it("tolerates small xy drift but flags a different color", () => {
    expect(
      lightStateConverged(
        { on: true, color: { xy: [0.701, 0.299] } },
        { on: true, color: { xy: [0.7, 0.3] } },
      ),
    ).toBe(true);
    expect(
      lightStateConverged(
        { on: true, color: { xy: [0.701, 0.299] } },
        { on: true, color: { xy: [0.15, 0.06] } },
      ),
    ).toBe(false);
  });

  it("tolerates small brightness drift but flags a large one", () => {
    expect(lightStateConverged({ on: true, brightness: 200 }, { on: true, brightness: 202 })).toBe(
      true,
    );
    expect(lightStateConverged({ on: true, brightness: 200 }, { on: true, brightness: 120 })).toBe(
      false,
    );
  });

  it("on/off mismatch is always diverged regardless of color/brightness", () => {
    expect(lightStateConverged({ on: true }, { on: false })).toBe(false);
  });

  it("rgb vs kelvin color modes are diverged", () => {
    expect(
      lightStateConverged(
        { on: true, color: { rgb: [255, 0, 0] } },
        { on: true, color: { kelvin: 4000 } },
      ),
    ).toBe(false);
  });
});

// ─── pure decision matrix ─────────────────────────────────────────────────────

function dev(
  overrides: Partial<{
    desiredState: DeviceLightState | null;
    control: LightControl;
    desiredUntilUtc: Date | null;
  }> = {},
) {
  return {
    id: "living-globe",
    entityId: "light.living_room_globe",
    domain: "light",
    control: overrides.control ?? LightControl.Enforce,
    desiredState: overrides.desiredState ?? null,
    desiredUntilUtc: overrides.desiredUntilUtc ?? null,
  };
}

describe("decideEnforcement", () => {
  it("seeds desired from reported when desired is null (no push)", () => {
    const d = decideEnforcement(dev({ desiredState: null }), {
      reported: { on: true, brightness: 180 },
      available: true,
    });
    expect(d.kind).toBe("seed");
    if (d.kind === "seed") expect(d.desired).toEqual({ on: true, brightness: 180 });
  });

  it("does nothing when desired and reported are converged", () => {
    const d = decideEnforcement(dev({ desiredState: { on: true, brightness: 200 } }), {
      reported: { on: true, brightness: 202 },
      available: true,
    });
    expect(d.kind).toBe("noop");
  });

  it("enforce + drift -> push desired to HA", () => {
    const desired: DeviceLightState = { on: true, color: { rgb: [255, 0, 0] } };
    const d = decideEnforcement(dev({ control: LightControl.Enforce, desiredState: desired }), {
      reported: { on: true, color: { rgb: [0, 0, 255] } },
      available: true,
    });
    expect(d.kind).toBe("push");
    if (d.kind === "push") expect(d.desired).toBe(desired);
  });

  it("adopt + drift -> set desired = reported (no push)", () => {
    const reported: DeviceLightState = { on: true, color: { rgb: [0, 0, 255] } };
    const d = decideEnforcement(
      dev({ control: LightControl.Adopt, desiredState: { on: true, color: { rgb: [255, 0, 0] } } }),
      { reported, available: true },
    );
    expect(d.kind).toBe("adopt");
    if (d.kind === "adopt") expect(d.desired).toEqual(reported);
  });

  it("unreachable -> mark unavailable, no push/adopt", () => {
    const d = decideEnforcement(
      dev({ control: LightControl.Enforce, desiredState: { on: true } }),
      {
        reported: null,
        available: false,
      },
    );
    expect(d.kind).toBe("unreachable");
  });

  it("does not seed an unreachable device with null desired", () => {
    const d = decideEnforcement(dev({ desiredState: null }), { reported: null, available: false });
    expect(d.kind).toBe("unreachable");
  });

  it("yields COLOR to the party engine while party active (no push on color drift)", () => {
    // mode=party: the party engine owns lamp color, so a color-only divergence
    // must NOT trigger an enforce push , otherwise the 1s enforcer fights the
    // animation. on/off matches here, so the enforcer stands down.
    const d = decideEnforcement(
      dev({
        control: LightControl.Enforce,
        desiredState: { on: true, color: { rgb: [255, 0, 0] } },
      }),
      { reported: { on: true, color: { rgb: [0, 255, 0] } }, available: true },
      true, // partyActive
    );
    expect(d.kind).toBe("noop");
  });

  it("still enforces ON/OFF for lamps while party active", () => {
    // Party yields color, NOT on/off: a lamp HA-reported off while desired on
    // must still be pushed back on so the wave stays lit.
    const d = decideEnforcement(
      dev({
        control: LightControl.Enforce,
        desiredState: { on: true, color: { rgb: [255, 0, 0] } },
      }),
      { reported: { on: false }, available: true },
      true, // partyActive
    );
    expect(d.kind).toBe("push");
  });
});

// ─── command window (www-unxz.1) ───────────────────────────────────────────────
// An app command writes desired + a short desiredUntilUtc window. While inside it,
// the enforcer PUSHES the freshly-set desired regardless of control policy , the
// command owns the transition until it converges or the window expires. Without
// this, an ADOPT device would revert a just-issued command before it was ever
// actuated (the mutations no longer push to HA themselves).

describe("decideEnforcement command window", () => {
  const now = new Date("2026-01-01T00:00:05Z");
  const future = new Date("2026-01-01T00:00:10Z"); // window still open
  const past = new Date("2026-01-01T00:00:01Z"); // window expired

  it("adopt + drift INSIDE the command window -> push (app command owns it)", () => {
    const desired: DeviceLightState = { on: true };
    const d = decideEnforcement(
      dev({ control: LightControl.Adopt, desiredState: desired, desiredUntilUtc: future }),
      { reported: { on: false }, available: true },
      false, // partyActive
      now,
    );
    expect(d.kind).toBe("push");
    if (d.kind === "push") expect(d.desired).toBe(desired);
  });

  it("adopt + drift AFTER the window expired -> adopt (absorb external change)", () => {
    const reported: DeviceLightState = { on: false };
    const d = decideEnforcement(
      dev({ control: LightControl.Adopt, desiredState: { on: true }, desiredUntilUtc: past }),
      { reported, available: true },
      false, // partyActive
      now,
    );
    expect(d.kind).toBe("adopt");
    if (d.kind === "adopt") expect(d.desired).toEqual(reported);
  });

  it("converged inside the window is still a noop (no needless push)", () => {
    const d = decideEnforcement(
      dev({ control: LightControl.Adopt, desiredState: { on: true }, desiredUntilUtc: future }),
      { reported: { on: true }, available: true },
      false, // partyActive
      now,
    );
    expect(d.kind).toBe("noop");
  });
});

// ─── cycle integration (in-memory DeviceStateStore + mocked HA/lampMode/heartbeat) ──

// A generic thenable/query-builder stand-in for the two tables the enforcer still
// reads straight off `db`: lampMode (isPartyActive) and integrationSyncStatus
// (the heartbeat's failure-streak read). Resolves per-table via `resolvers`,
// keyed by the schema object passed to `.from(...)`.
function tableChain(resolvers: Map<unknown, unknown[]>) {
  let table: unknown;
  const rowsFor = () => resolvers.get(table) ?? [];
  const chain = {
    from(t: unknown) {
      table = t;
      return chain;
    },
    where() {
      return chain;
    },
    limit(): Promise<unknown[]> {
      return Promise.resolve(rowsFor());
    },
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable for drizzle mock
    then<R>(onFulfilled: (v: unknown[]) => R | PromiseLike<R>): Promise<R> {
      return Promise.resolve(rowsFor()).then(onFulfilled);
    },
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCallService.mockResolvedValue(undefined);
  // lampMode -> not party; integrationSyncStatus -> no prior failure streak.
  mockDbSelect.mockImplementation(() =>
    tableChain(
      new Map<unknown, unknown[]>([
        [lampMode, []],
        [integrationSyncStatus, []],
      ]),
    ),
  );
  // markHeartbeat: insert().values().onConflictDoUpdate()
  mockDbInsert.mockReturnValue({
    values: vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }),
  });
});

describe("runEnforcerCycle", () => {
  function haEntity(entity_id: string, state: string, attributes: Record<string, unknown> = {}) {
    return { entity_id, state, attributes };
  }

  async function seededStore(row: {
    desiredState: DeviceLightState | null;
    reportedState: DeviceLightState | null;
    available: boolean;
  }) {
    const store = createInMemoryDeviceStateStore();
    await store.seed({
      id: "living-globe",
      kind: DeviceKind.Light,
      entityId: "light.living_room_globe",
      domain: "light",
      label: "Globe",
      reported: row.reportedState,
      desired: row.desiredState,
      available: row.available,
    });
    return store;
  }

  it("enforce + drift pushes to HA and refreshes reported (desired untouched)", async () => {
    // One enforce lamp whose reported rgb diverges from desired rgb.
    const store = await seededStore({
      desiredState: { on: true, color: { rgb: [255, 0, 0] } },
      reportedState: { on: true, color: { rgb: [255, 0, 0] } },
      available: true,
    });
    mockGetEntities.mockImplementation((domain: string) =>
      domain === "light"
        ? Promise.resolve([haEntity("light.living_room_globe", "on", { rgb_color: [0, 0, 255] })])
        : Promise.resolve([]),
    );

    await runEnforcerCycle(store);

    // enforce -> light.turn_on with the desired rgb pushed.
    const pushed = mockCallService.mock.calls.find((c) => c[0] === "light" && c[1] === "turn_on");
    expect(pushed).toBeDefined();
    expect(pushed?.[2]).toMatchObject({
      entity_id: "light.living_room_globe",
      rgb_color: [255, 0, 0],
    });

    const row = await store.read("living-globe");
    // push never writes desiredState , the enforcer's own push isn't an adopt.
    expect(row?.desiredState).toEqual({ on: true, color: { rgb: [255, 0, 0] } });
    expect(row?.reportedState).toEqual({ on: true, color: { rgb: [0, 0, 255] } });
    expect(row?.available).toBe(true);
  });

  it("converged device makes no HA call", async () => {
    const store = await seededStore({
      desiredState: { on: true, color: { rgb: [0, 0, 255] } },
      reportedState: { on: true, color: { rgb: [0, 0, 255] } },
      available: true,
    });
    mockGetEntities.mockImplementation((domain: string) =>
      domain === "light"
        ? Promise.resolve([haEntity("light.living_room_globe", "on", { rgb_color: [0, 1, 254] })])
        : Promise.resolve([]),
    );

    await runEnforcerCycle(store);

    const pushed = mockCallService.mock.calls.find(
      (c) => c[1] === "turn_on" || c[1] === "turn_off",
    );
    expect(pushed).toBeUndefined();

    const row = await store.read("living-globe");
    expect(row?.reportedState).toEqual({ on: true, color: { rgb: [0, 1, 254] } });
    expect(row?.available).toBe(true);
  });

  it("does not re-send the 4000 K outage response reported in color_temp mode", async () => {
    const store = await seededStore({
      desiredState: { on: true, color: { kelvin: 4000 } },
      reportedState: { on: true, color: { kelvin: 4000 } },
      available: true,
    });
    mockGetEntities.mockImplementation((domain: string) =>
      domain === "light"
        ? Promise.resolve([
            haEntity("light.living_room_globe", "on", {
              color_mode: "color_temp",
              supported_color_modes: ["color_temp", "xy"],
              color_temp_kelvin: 4000,
              rgb_color: [255, 206, 166],
              xy_color: [0.42, 0.365],
              hs_color: [26.812, 34.87],
            }),
          ])
        : Promise.resolve([]),
    );

    await runEnforcerCycle(store);

    expect(mockCallService).not.toHaveBeenCalled();
    expect((await store.read("living-globe"))?.reportedState).toEqual({
      on: true,
      color: { kelvin: 4000 },
    });
  });

  it("does not re-send a colored light already reported in xy mode", async () => {
    const store = await seededStore({
      desiredState: { on: true, color: { xy: [0.701, 0.299] } },
      reportedState: { on: true, color: { xy: [0.701, 0.299] } },
      available: true,
    });
    mockGetEntities.mockImplementation((domain: string) =>
      domain === "light"
        ? Promise.resolve([
            haEntity("light.living_room_globe", "on", {
              color_mode: "xy",
              supported_color_modes: ["color_temp", "xy"],
              xy_color: [0.7, 0.3],
              rgb_color: [255, 0, 0],
            }),
          ])
        : Promise.resolve([]),
    );

    await runEnforcerCycle(store);

    expect(mockCallService).not.toHaveBeenCalled();
    expect((await store.read("living-globe"))?.reportedState).toEqual({
      on: true,
      color: { xy: [0.7, 0.3] },
    });
  });

  it("pushes a divergent xy color using Home Assistant's xy_color parameter", async () => {
    const store = await seededStore({
      desiredState: { on: true, color: { xy: [0.701, 0.299] } },
      reportedState: { on: true, color: { xy: [0.15, 0.06] } },
      available: true,
    });
    mockGetEntities.mockImplementation((domain: string) =>
      domain === "light"
        ? Promise.resolve([
            haEntity("light.living_room_globe", "on", {
              color_mode: "xy",
              xy_color: [0.15, 0.06],
              rgb_color: [0, 0, 255],
            }),
          ])
        : Promise.resolve([]),
    );

    await runEnforcerCycle(store);

    expect(mockCallService).toHaveBeenCalledWith("light", "turn_on", {
      entity_id: "light.living_room_globe",
      xy_color: [0.701, 0.299],
    });
  });

  it("persists FRESH reportedState from HA every cycle (panel never reads stale/zero)", async () => {
    // device-sync is fan-only now, so the enforcer is the sole writer of lamp
    // reportedState. If it doesn't persist it, getControlsState's overlay has no
    // fresh reported to fall back to → brightness 0 / no scene / stuck pending.
    const store = await seededStore({
      desiredState: { on: true }, // bare toggle , no brightness/color intent
      reportedState: { on: true, brightness: 10 }, // stale
      available: true,
    });
    mockGetEntities.mockImplementation((domain: string) =>
      domain === "light"
        ? Promise.resolve([
            haEntity("light.living_room_globe", "on", { brightness: 200, rgb_color: [0, 0, 255] }),
          ])
        : Promise.resolve([]),
    );

    await runEnforcerCycle(store);

    const row = await store.read("living-globe");
    expect(row?.reportedState).toEqual({
      on: true,
      brightness: 200,
      color: { rgb: [0, 0, 255] },
    });
  });

  it("unreachable device marks unavailable and leaves desired untouched", async () => {
    const store = await seededStore({
      desiredState: { on: true, brightness: 180 },
      reportedState: { on: true, brightness: 180 },
      available: true,
    });
    // No entity in the snapshot at all -> unreachable.
    mockGetEntities.mockResolvedValue([]);

    await runEnforcerCycle(store);

    const row = await store.read("living-globe");
    expect(row?.available).toBe(false);
    expect(row?.desiredState).toEqual({ on: true, brightness: 180 });
  });

  it("seeds desired from reported on first sight (no push, no adopt)", async () => {
    const store = await seededStore({
      desiredState: null,
      reportedState: null,
      available: true,
    });
    mockGetEntities.mockImplementation((domain: string) =>
      domain === "light"
        ? Promise.resolve([haEntity("light.living_room_globe", "on", { brightness: 100 })])
        : Promise.resolve([]),
    );

    await runEnforcerCycle(store);

    expect(mockCallService).not.toHaveBeenCalled();
    const row = await store.read("living-globe");
    expect(row?.desiredState).toEqual({ on: true, brightness: 100 });
    expect(row?.reportedState).toEqual({ on: true, brightness: 100 });
  });
});
