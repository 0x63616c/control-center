/**
 * Tests for the DB-authoritative climate enforcer (www-unxz.2).
 *
 * The reconcile decision is a PURE function (decideClimateEnforcement) so the
 * seed/push/noop/unreachable matrix is tested directly. Cycle-level tests then
 * use an in-memory DeviceStateStore (mocking only db+ha) to prove the decisions
 * are executed: seeds the row on first HA sight (no push), pushes desired→HA on
 * drift, and writes real ambient/hvac_action into reportedState every cycle.
 */
import { createInMemoryDeviceStateStore, DeviceKind } from "@www/core";
import { getLogger, resetChangeLog } from "@www/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── mock DB (climate-enforcer no longer touches device_state directly , that
// goes through the DeviceStateStore. `db` is still used by the shared
// integration-heartbeat helper for integrationSyncStatus.) ────────────────────

const { mockDbSelect, mockDbInsert } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
}));

const { mockGetEntities, mockCallService, mockRecordOk, mockRecordFail } = vi.hoisted(() => ({
  mockGetEntities: vi.fn(),
  mockCallService: vi.fn(),
  mockRecordOk: vi.fn(),
  mockRecordFail: vi.fn(),
}));

vi.mock("./deps", () => ({
  deviceStateStore: {},
  integrationSyncStore: { recordOk: mockRecordOk, recordFail: mockRecordFail },
  ha: { getEntities: mockGetEntities, callService: mockCallService },
}));

import type { DeviceClimateState, MappedHaState } from "@www/core";
import { CLIMATE_DEVICE_ID } from "@www/core";
import { decideClimateEnforcement, runClimateEnforcerCycle } from "./enforcer";

// ─── pure decision tests ──────────────────────────────────────────────────────

function mapped(reported: DeviceClimateState | null, available = true): MappedHaState {
  return { reported, available };
}

describe("decideClimateEnforcement (pure)", () => {
  it("seeds desired from reported when desired is null (no push), STRIPPING reported-only fields (www-dnpj)", () => {
    const reported: DeviceClimateState = { mode: "cool", target: 70, ambient: 72, action: "idle" };
    const d = decideClimateEnforcement(
      { id: "c", entityId: "climate.home", desiredState: null, desiredUntilUtc: null },
      mapped(reported),
    );
    // ambient/action are reported-only , a desired carrying them would shadow the
    // live reported values in the merge overlay and freeze the panel's room temp.
    expect(d).toEqual({ kind: "seed", desired: { mode: "cool", target: 70 } });
  });

  it("noop when desired and reported converge on the commandable fields", () => {
    const d = decideClimateEnforcement(
      {
        id: "c",
        entityId: "climate.home",
        desiredState: { mode: "cool", target: 70 },
        desiredUntilUtc: null,
      },
      // ambient/action differ but are reported-only → still converged.
      mapped({ mode: "cool", target: 70, ambient: 99, action: "cooling" }),
    );
    expect(d).toEqual({ kind: "noop" });
  });

  // www-qktc: the thermostat has a physical interface (wall unit + ecobee app),
  // so its policy is ADOPT, like the Shelly wall switches: external drift outside
  // the app-command window is absorbed as new intent (desired := reported),
  // never fought. Only a fresh dashboard tap (inside desiredUntilUtc) pushes.
  const NOW = new Date("2026-06-10T00:00:00Z");
  const WINDOW_OPEN = new Date(NOW.getTime() + 5_000);
  const WINDOW_EXPIRED = new Date(NOW.getTime() - 5_000);

  it("adopts external mode drift outside the command window (www-qktc , last writer wins)", () => {
    const d = decideClimateEnforcement(
      {
        id: "c",
        entityId: "climate.home",
        desiredState: { mode: "off", target: 70 },
        desiredUntilUtc: null,
      },
      mapped({ mode: "cool", target: 70, ambient: 75, action: "cooling" }),
      NOW,
    );
    // Adopted desired is the COMMANDABLE slice of reported (www-dnpj sanitize).
    expect(d).toEqual({ kind: "adopt", desired: { mode: "cool", target: 70 } });
  });

  it("adopts external setpoint drift outside the command window", () => {
    const d = decideClimateEnforcement(
      {
        id: "c",
        entityId: "climate.home",
        desiredState: { mode: "cool", target: 68 },
        desiredUntilUtc: null,
      },
      mapped({ mode: "cool", target: 72 }),
      NOW,
    );
    expect(d).toEqual({ kind: "adopt", desired: { mode: "cool", target: 72 } });
  });

  it("adopts an external fan_mode change when the AC is idle, outside the window", () => {
    const d = decideClimateEnforcement(
      {
        id: "c",
        entityId: "climate.home",
        desiredState: { mode: "cool", target: 70, fanMode: "on" },
        desiredUntilUtc: null,
      },
      mapped({ mode: "cool", target: 70, fanMode: "auto", action: "idle" }),
      NOW,
    );
    expect(d).toEqual({ kind: "adopt", desired: { mode: "cool", target: 70, fanMode: "auto" } });
  });

  it("adopting while conditioning keeps the prior desired fan_mode (never absorbs the AC-asserted blower)", () => {
    const d = decideClimateEnforcement(
      {
        id: "c",
        entityId: "climate.home",
        desiredState: { mode: "cool", target: 68, fanMode: "auto" },
        desiredUntilUtc: null,
      },
      // External setpoint change to 72 while cooling; HA reports fan_mode="on"
      // only because the compressor is running (www-pu4m) , that is not intent.
      mapped({ mode: "cool", target: 72, fanMode: "on", action: "cooling" }),
      NOW,
    );
    expect(d).toEqual({
      kind: "adopt",
      desired: { mode: "cool", target: 72, fanMode: "auto" },
    });
  });

  it("pushes desired on drift INSIDE the command window (dashboard tap actuates)", () => {
    const desired: DeviceClimateState = { mode: "cool", target: 68 };
    const d = decideClimateEnforcement(
      {
        id: "c",
        entityId: "climate.home",
        desiredState: desired,
        desiredUntilUtc: WINDOW_OPEN,
      },
      mapped({ mode: "cool", target: 72 }),
      NOW,
    );
    expect(d).toEqual({ kind: "push", desired });
  });

  it("an EXPIRED command window adopts (the window is the only push authority)", () => {
    const d = decideClimateEnforcement(
      {
        id: "c",
        entityId: "climate.home",
        desiredState: { mode: "cool", target: 68 },
        desiredUntilUtc: WINDOW_EXPIRED,
      },
      mapped({ mode: "cool", target: 72 }),
      NOW,
    );
    expect(d).toEqual({ kind: "adopt", desired: { mode: "cool", target: 72 } });
  });

  // www-pu4m: while the AC is actively cooling/heating it OWNS its blower and
  // reports fan_mode="on". A desired fan_mode that disagrees is the AC asserting
  // the fan, NOT drift to fight , pushing it every cycle caused on/off/on/off.
  it("yields fan_mode while the AC is actively cooling (noop when only fan differs)", () => {
    const desired: DeviceClimateState = { mode: "cool", target: 70, fanMode: "auto" };
    const d = decideClimateEnforcement(
      { id: "c", entityId: "climate.home", desiredState: desired, desiredUntilUtc: null },
      mapped({ mode: "cool", target: 70, fanMode: "on", action: "cooling" }),
    );
    expect(d).toEqual({ kind: "noop" });
  });

  it("yields fan_mode while the AC is actively heating", () => {
    const desired: DeviceClimateState = { mode: "heat", target: 70, fanMode: "auto" };
    const d = decideClimateEnforcement(
      { id: "c", entityId: "climate.home", desiredState: desired, desiredUntilUtc: null },
      mapped({ mode: "heat", target: 70, fanMode: "on", action: "heating" }),
    );
    expect(d).toEqual({ kind: "noop" });
  });

  it("pushes a real drift while conditioning INSIDE the window, but STRIPS fan_mode (never fights the blower)", () => {
    const desired: DeviceClimateState = { mode: "cool", target: 68, fanMode: "auto" };
    const d = decideClimateEnforcement(
      {
        id: "c",
        entityId: "climate.home",
        desiredState: desired,
        desiredUntilUtc: WINDOW_OPEN,
      },
      mapped({ mode: "cool", target: 72, fanMode: "on", action: "cooling" }),
      NOW,
    );
    // fan_mode omitted from the pushed desired so set_fan_mode is never called.
    expect(d).toEqual({ kind: "push", desired: { mode: "cool", target: 68 } });
  });

  // ── OFF remembers the last real setpoint ───────────────────────────────────
  // HA reports NO setpoint attributes while the thermostat is off. Adopting that
  // verbatim forgot the setpoint, so the next off→cool had no number: the tile
  // showed 0°F until HA re-reported one seconds later.

  it("adopting an external OFF keeps the standing desired setpoint as memory", () => {
    const d = decideClimateEnforcement(
      {
        id: "c",
        entityId: "climate.home",
        desiredState: { mode: "cool", target: 72 },
        desiredUntilUtc: null,
      },
      mapped({ mode: "off", ambient: 81, action: "off" }),
    );
    expect(d).toEqual({ kind: "adopt", desired: { mode: "off", target: 72 } });
  });

  it("falls back to the last REPORTED setpoint when desired carries none", () => {
    const d = decideClimateEnforcement(
      {
        id: "c",
        entityId: "climate.home",
        desiredState: { mode: "cool" },
        lastReported: { mode: "cool", target: 74, ambient: 80 },
        desiredUntilUtc: null,
      },
      mapped({ mode: "off", ambient: 81 }),
    );
    expect(d).toEqual({ kind: "adopt", desired: { mode: "off", target: 74 } });
  });

  it("noop while off , a remembered setpoint HA cannot report is not drift", () => {
    const d = decideClimateEnforcement(
      {
        id: "c",
        entityId: "climate.home",
        desiredState: { mode: "off", target: 72 },
        desiredUntilUtc: null,
      },
      mapped({ mode: "off", ambient: 81 }),
    );
    expect(d).toEqual({ kind: "noop" });
  });

  it("unreachable when HA is unavailable or reports no climate state", () => {
    expect(
      decideClimateEnforcement(
        {
          id: "c",
          entityId: "climate.home",
          desiredState: { mode: "cool" },
          desiredUntilUtc: null,
        },
        mapped(null, false),
      ),
    ).toEqual({ kind: "unreachable" });
  });
});

// ─── cycle tests (in-memory DeviceStateStore + mocked HA/heartbeat) ───────────

// A generic thenable/query-builder stand-in for the one table the enforcer
// still reads straight off `db`: integrationSyncStatus (the heartbeat's
// failure-streak read). device_state now goes through the store, not this mock.
function tableChain(rows: unknown[]) {
  const chain = {
    from() {
      return chain;
    },
    where() {
      return chain;
    },
    limit(): Promise<unknown[]> {
      return Promise.resolve(rows);
    },
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable for drizzle mock
    then<R>(onFulfilled: (v: unknown[]) => R | PromiseLike<R>): Promise<R> {
      return Promise.resolve(rows).then(onFulfilled);
    },
  };
  return chain;
}

function haClimate(attributes: Record<string, unknown>, state = "cool") {
  return { entity_id: "climate.home", state, attributes };
}

// logChange suppresses a repeated identical signature for the same key within
// its window (docs/logging.md §3), which would silently swallow assertions
// across tests that reuse "climate.home" as the entity id. Reset before every
// test so each one observes a fresh emission, and spy on info so the
// push/adopt/unreachable lines below can be asserted without depending on log
// output (the root logger is seeded silent by setup-logger.ts).
let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockCallService.mockResolvedValue(undefined);
  mockRecordOk.mockResolvedValue(undefined);
  mockRecordFail.mockResolvedValue(1);
  // integrationSyncStatus -> no prior failure streak.
  mockDbSelect.mockImplementation(() => tableChain([]));
  // markHeartbeat: insert().values().onConflictDoUpdate()
  mockDbInsert.mockReturnValue({
    values: vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }),
  });
  resetChangeLog();
  infoSpy = vi.spyOn(getLogger(), "info");
});

afterEach(() => {
  infoSpy.mockRestore();
});

describe("runClimateEnforcerCycle", () => {
  it("seeds the row on first HA sight (insert, NO push)", async () => {
    const store = createInMemoryDeviceStateStore();
    mockGetEntities.mockResolvedValue([
      haClimate({ current_temperature: 72, temperature: 70, hvac_action: "cooling" }),
    ]);

    await runClimateEnforcerCycle(store);

    // The seed carries reported + desired (= reported) from real HA values.
    const row = await store.read(CLIMATE_DEVICE_ID);
    expect(row?.reportedState).toMatchObject({ mode: "cool", target: 70, ambient: 72 });
    // Desired carries ONLY commandable fields , never the reported-only
    // ambient/action (www-dnpj: they'd freeze the panel's room temp at seed time).
    expect(row?.desiredState).toEqual({ mode: "cool", target: 70 });
    expect(row?.reportedAtUtc).not.toBeNull();
    expect(row?.desiredAtUtc).not.toBeNull();
    // Seeding never actuates HA.
    expect(mockCallService).not.toHaveBeenCalled();
  });

  it("does nothing when there is no row yet and HA is unreachable (never fabricates a row from thin air)", async () => {
    const store = createInMemoryDeviceStateStore();
    mockGetEntities.mockResolvedValue([]); // thermostat absent from HA's snapshot

    await runClimateEnforcerCycle(store);

    expect(await store.read(CLIMATE_DEVICE_ID)).toBeNull();
    expect(mockCallService).not.toHaveBeenCalled();
  });

  it("self-heals a stale desired that carries reported-only ambient/action (www-dnpj), bumping desiredAtUtc", async () => {
    // Prod repro: desired was seeded pre-fix as a wholesale copy of reported, so
    // it still carries ambient/action. The cycle must persist a sanitized desired
    // (no manual migration) while leaving the commandable fields untouched.
    // Routed through writeReported's adoptDesired (controller-approved www-dnpj
    // deviation): the self-heal now also bumps desiredAtUtc, which is fine ,
    // nothing enforcement-critical reads it (the command window uses
    // desiredUntilUtc), and the heal only fires on pre-fix rows. Pin the clock so
    // the bump is asserted precisely, not just "probably later".
    const store = createInMemoryDeviceStateStore();
    const seededAt = new Date("2026-01-01T00:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(seededAt);
    try {
      await store.seed({
        id: CLIMATE_DEVICE_ID,
        kind: DeviceKind.Climate,
        entityId: "climate.home",
        domain: "climate",
        label: "Thermostat",
        desired: { mode: "cool", target: 72, fanMode: "on", ambient: 71, action: "cooling" },
        reported: { mode: "cool", target: 72, fanMode: "auto", ambient: 73, action: "cooling" },
        available: true,
      });
      const before = await store.read(CLIMATE_DEVICE_ID);
      expect(before?.desiredAtUtc).toEqual(seededAt);

      const healedAt = new Date("2026-01-01T00:05:00Z");
      vi.setSystemTime(healedAt);
      mockGetEntities.mockResolvedValue([
        haClimate({
          current_temperature: 73,
          temperature: 72,
          fan_mode: "auto",
          hvac_action: "cooling",
        }),
      ]);

      await runClimateEnforcerCycle(store);

      // Converged on commandable fields (fan yielded while cooling) → no actuation.
      expect(mockCallService).not.toHaveBeenCalled();
      const row = await store.read(CLIMATE_DEVICE_ID);
      expect(row?.desiredState).toEqual({ mode: "cool", target: 72, fanMode: "on" });
      // The self-heal write bumped desiredAtUtc to this cycle's clock , if the
      // adoptDesired routing regresses to a bare desiredState write (or is
      // dropped), this stays pinned at seededAt and the assertion fails.
      expect(row?.desiredAtUtc).toEqual(healedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pushes desired→HA on drift inside the command window (set_hvac_mode + set_temperature + set_fan_mode)", async () => {
    const store = createInMemoryDeviceStateStore();
    await store.seed({
      id: CLIMATE_DEVICE_ID,
      kind: DeviceKind.Climate,
      entityId: "climate.home",
      domain: "climate",
      label: "Thermostat",
      desired: { mode: "cool", target: 68, fanMode: "on" },
      reported: { mode: "cool", target: 72, fanMode: "auto" },
      available: true,
    });
    // Fresh dashboard tap: the command window is open, so desired pushes.
    await store.updateDesired({
      id: CLIMATE_DEVICE_ID,
      desired: { mode: "cool", target: 68, fanMode: "on" },
      windowMs: 9_000,
    });
    mockGetEntities.mockResolvedValue([
      haClimate({ current_temperature: 72, temperature: 72, fan_mode: "auto" }),
    ]);

    await runClimateEnforcerCycle(store);

    expect(mockCallService).toHaveBeenCalledWith("climate", "set_hvac_mode", {
      entity_id: "climate.home",
      hvac_mode: "cool",
    });
    expect(mockCallService).toHaveBeenCalledWith("climate", "set_temperature", {
      entity_id: "climate.home",
      temperature: 68,
    });
    expect(mockCallService).toHaveBeenCalledWith("climate", "set_fan_mode", {
      entity_id: "climate.home",
      fan_mode: "on",
    });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "climate.home", mode: "cool", target: 68 }),
      "climate enforcer pushing desired state to HA",
    );
  });

  it("turning OFF pushes the mode only , a remembered setpoint is never actuated", async () => {
    const store = createInMemoryDeviceStateStore();
    await store.seed({
      id: CLIMATE_DEVICE_ID,
      kind: DeviceKind.Climate,
      entityId: "climate.home",
      domain: "climate",
      label: "Thermostat",
      // Desired carries the remembered setpoint for the next on; HA takes no
      // set_temperature while off.
      desired: { mode: "off", target: 72 },
      reported: { mode: "cool", target: 72, ambient: 81 },
      available: true,
    });
    await store.updateDesired({
      id: CLIMATE_DEVICE_ID,
      desired: { mode: "off", target: 72 },
      windowMs: 9_000,
    });
    mockGetEntities.mockResolvedValue([haClimate({ current_temperature: 81, temperature: 72 })]);

    await runClimateEnforcerCycle(store);

    expect(mockCallService).toHaveBeenCalledWith("climate", "set_hvac_mode", {
      entity_id: "climate.home",
      hvac_mode: "off",
    });
    expect(mockCallService).not.toHaveBeenCalledWith(
      "climate",
      "set_temperature",
      expect.anything(),
    );
  });

  it("ADOPTS an external setpoint change outside the window: no HA call, desired := reported (www-qktc)", async () => {
    // Prod repro 2026-06-10: setpoint changed on the physical ecobee (75) was
    // reverted to the dashboard's 72 within 190ms. It must persist instead.
    const store = createInMemoryDeviceStateStore();
    await store.seed({
      id: CLIMATE_DEVICE_ID,
      kind: DeviceKind.Climate,
      entityId: "climate.home",
      domain: "climate",
      label: "Thermostat",
      desired: { mode: "cool", target: 72 },
      reported: { mode: "cool", target: 72, ambient: 77 },
      available: true,
    });
    mockGetEntities.mockResolvedValue([
      haClimate({ current_temperature: 77, temperature: 75, hvac_action: "cooling" }),
    ]);

    await runClimateEnforcerCycle(store);

    // The wall change is absorbed, never fought.
    expect(mockCallService).not.toHaveBeenCalled();
    const row = await store.read(CLIMATE_DEVICE_ID);
    expect(row?.desiredState).toEqual({ mode: "cool", target: 75 });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "climate.home",
        adoptedMode: "cool",
        adoptedTarget: 75,
      }),
      "climate enforcer adopted reported state",
    );
  });

  it("writes FRESH reportedState (incl. real ambient/action) every cycle, no push when converged", async () => {
    const store = createInMemoryDeviceStateStore();
    await store.seed({
      id: CLIMATE_DEVICE_ID,
      kind: DeviceKind.Climate,
      entityId: "climate.home",
      domain: "climate",
      label: "Thermostat",
      desired: { mode: "cool", target: 70 },
      reported: { mode: "cool", target: 70, ambient: 71 },
      available: true,
    });
    mockGetEntities.mockResolvedValue([
      haClimate({ current_temperature: 73, temperature: 70, hvac_action: "cooling" }),
    ]);

    await runClimateEnforcerCycle(store);

    // Converged commandable fields → no actuation.
    expect(mockCallService).not.toHaveBeenCalled();
    // But reported is refreshed with the real ambient/action from HA.
    const row = await store.read(CLIMATE_DEVICE_ID);
    expect(row?.reportedState).toMatchObject({
      mode: "cool",
      ambient: 73,
      action: "cooling",
    });
  });

  it("does NOT push fan_mode while actively cooling , regression: no on/off/on/off flicker (www-pu4m)", async () => {
    // User scenario: AC cool, ambient 75 > target 70 (actively cooling), fan
    // turned off via Controls (desired fanMode=auto). HA reports fan_mode=on
    // because the compressor is running. The enforcer must NOT re-push the fan.
    const store = createInMemoryDeviceStateStore();
    await store.seed({
      id: CLIMATE_DEVICE_ID,
      kind: DeviceKind.Climate,
      entityId: "climate.home",
      domain: "climate",
      label: "Thermostat",
      desired: { mode: "cool", target: 70, fanMode: "auto" },
      reported: { mode: "cool", target: 70, fanMode: "on", ambient: 75, action: "cooling" },
      available: true,
    });
    mockGetEntities.mockResolvedValue([
      haClimate({
        current_temperature: 75,
        temperature: 70,
        fan_mode: "on",
        hvac_action: "cooling",
      }),
    ]);

    await runClimateEnforcerCycle(store);

    expect(mockCallService).not.toHaveBeenCalled();
  });

  it("marks unavailable when HA does not report the configured thermostat", async () => {
    const store = createInMemoryDeviceStateStore();
    await store.seed({
      id: CLIMATE_DEVICE_ID,
      kind: DeviceKind.Climate,
      entityId: "climate.home",
      domain: "climate",
      label: "Thermostat",
      desired: { mode: "cool", target: 70 },
      reported: { mode: "cool", target: 70 },
      available: true,
    });
    mockGetEntities.mockResolvedValue([]); // thermostat absent

    await runClimateEnforcerCycle(store);

    expect(mockCallService).not.toHaveBeenCalled();
    const row = await store.read(CLIMATE_DEVICE_ID);
    expect(row?.available).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "climate.home" }),
      "climate enforcer lost the thermostat",
    );
  });
});
