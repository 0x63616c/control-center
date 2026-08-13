/**
 * Unit tests for the controls service + router.
 *
 * All network/HA calls are mocked via vi.mock , no Postgres or real HA needed.
 * Service-level describes inject an in-memory DeviceStateStore directly. The
 * router-level describes exercise the module-default store (the singleton
 * `deviceStateStore` wrapping the mocked `db`), so those still drive it via the
 * `db` mock , that is the one remaining legitimate path to the default param.
 * `db` also still backs the (unrelated) lamp_mode singleton table.
 */
import {
  createInMemoryDeviceStateStore,
  type DeviceKind,
  type DeviceStateStore,
  FIXTURE_ENTITY_IDS,
  LAMP_ENTITY_IDS,
  rgbToXy,
} from "@www/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── mock the HA singleton ────────────────────────────────────────────────────

const { mockIsConfigured, mockGetEntities, mockCallService } = vi.hoisted(() => ({
  mockIsConfigured: vi.fn<() => boolean>(),
  mockGetEntities: vi.fn<(domain: string) => Promise<unknown>>(),
  mockCallService: vi.fn<() => Promise<void>>(),
}));

vi.mock("./deps", () => ({
  ha: {
    isConfigured: mockIsConfigured,
    getEntities: mockGetEntities,
    callService: mockCallService,
  },
}));

// ─── mock the DB ──────────────────────────────────────────────────────────────

const { mockDbSelect, mockDbUpdate, mockDbInsert } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbInsert: vi.fn(),
}));

// The `db` mock backs both the direct lamp_mode queries AND (via a REAL
// createPgDeviceStateStore bound to the same mock) the module-default
// `deviceStateStore` the router-level describes exercise , so `deviceStateStore`
// itself is never separately mocked, only the underlying `db` calls.
vi.mock("./db", async () => {
  const { createPgDeviceStateStore } = await import("@www/core");
  const mockDb = {
    select: mockDbSelect,
    update: mockDbUpdate,
    insert: mockDbInsert,
  };
  return {
    db: mockDb,
    deviceStateStore: createPgDeviceStateStore(
      mockDb as unknown as Parameters<typeof createPgDeviceStateStore>[0],
    ),
  };
});

// ─── import after mock ────────────────────────────────────────────────────────

import { router } from "@app-kit/server";
import { controlsRouter } from "./api";
import {
  LampMode,
  LampModeSpeed,
  LampScene,
  MOOD_PALETTE,
  WHITE_SCENE_KELVIN,
} from "./lamp-scenes";
import { lampMode } from "./schema";
import {
  ControlKey,
  FanMode,
  getControlsState,
  setLampBrightness,
  setLampMode,
  setLampScene,
  toggleControl,
} from "./service";

// ─── helpers ──────────────────────────────────────────────────────────────────
//
// Lamp/light state is now desired-authoritative (www-7d5b.2.4): getControlsState
// reads it from device_state rows (lampRow/fixtureRow below), NOT from live HA
// entities. HA is read only for the fan (climate fan_mode), so the only HA-entity
// builders still needed are the fan/climate ones.

function makeFan(id: string, state: "on" | "off", percentage?: number) {
  return {
    entity_id: `fan.${id}`,
    state,
    attributes: { friendly_name: id, ...(percentage !== undefined ? { percentage } : {}) },
    last_updated: new Date().toISOString(),
  };
}

// Build a chainable query mock. Every builder method returns a chain
// that ultimately resolves to `rows` when awaited.
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

/**
 * Drive db.select() so the lamp_mode singleton read (a PROJECTED select ,
 * db.select({ mode }) , which controls-service uses) resolves to a row with the
 * given mode, while every other (unprojected) select resolves to `deviceRows`.
 * Lets a test set the persistent lamp mode without colliding with the device-row
 * read in the same getControlsState call.
 */
function mockSelectWithMode(deviceRows: unknown[], mode: string | null): void {
  mockDbSelect.mockImplementation((projection?: unknown) => {
    if (projection !== undefined) {
      return makeSelectChain(mode === null ? [] : [{ mode }]);
    }
    return makeSelectChain(deviceRows);
  });
}

// Chainable insert mock for db.insert().values().onConflictDoUpdate().
// `valuesSpy` (when provided) records each .values() payload so a test can assert
// the desired-state written per entity (the mutations no longer call HA, so the
// desired write is the only observable side-effect , www-unxz.1).
class InsertChain {
  private readonly valuesSpy?: (payload: unknown) => void;
  constructor(valuesSpy?: (payload: unknown) => void) {
    this.valuesSpy = valuesSpy;
  }
  values(payload?: unknown): this {
    this.valuesSpy?.(payload);
    return this;
  }
  returning(): Promise<unknown[]> {
    return Promise.resolve([]);
  }
  onConflictDoUpdate(): Promise<void> {
    return Promise.resolve();
  }
  // biome-ignore lint/suspicious/noThenProperty: intentional thenable for drizzle mock
  then<R>(
    onFulfilled: (v: undefined) => R | PromiseLike<R>,
    onRejected?: (e: unknown) => R | PromiseLike<R>,
  ): Promise<R> {
    return Promise.resolve(undefined).then(onFulfilled, onRejected);
  }
}

function makeInsertChain(valuesSpy?: (payload: unknown) => void): InsertChain {
  return new InsertChain(valuesSpy);
}

// Captured `.values()` payload shape for a device_state upsert (the fields the
// assertions care about).
interface DesiredInsert {
  entityId?: string;
  desiredState?: { on: boolean; brightness?: number; color?: unknown };
  desiredUntilUtc?: Date;
}

/**
 * Wire db.insert() to capture every device_state upsert's `.values()` payload,
 * keyed by entityId. lamp_mode upserts (no entityId) are ignored. Lets a test
 * assert the desired written per entity without HA being involved.
 */
function captureDesiredWrites(): Map<string, DesiredInsert> {
  const byEntity = new Map<string, DesiredInsert>();
  mockDbInsert.mockImplementation(() =>
    makeInsertChain((payload) => {
      const p = payload as DesiredInsert;
      if (p?.entityId) byEntity.set(p.entityId, p);
    }),
  );
  return byEntity;
}

// Make a deviceState row with typical fields. Desired-authoritative (www-7d5b.2.4):
// getControlsState reads lamp/light state from desiredState (falling back to
// reportedState when desired is null), with availability honest.
function makeDeviceRow(
  overrides: Partial<{
    id: string;
    kind: string;
    entityId: string;
    domain: string;
    label: string;
    reportedState: unknown;
    desiredState: unknown;
    desiredUntilUtc: Date | null;
    available: boolean;
  }> = {},
) {
  return {
    id: overrides.id ?? "dev-1",
    kind: overrides.kind ?? "light",
    entityId: overrides.entityId ?? "light.lamp",
    domain: overrides.domain ?? "light",
    label: overrides.label ?? "Lamp",
    reportedState: overrides.reportedState ?? { on: false },
    desiredState: overrides.desiredState ?? null,
    desiredUntilUtc: overrides.desiredUntilUtc ?? null,
    desiredAtUtc: null,
    reportedAtUtc: null,
    reportedChangedAtUtc: null,
    available: overrides.available ?? true,
    createdAtUtc: new Date(),
    updatedAtUtc: new Date(),
  };
}

// A lamp device row whose DESIRED state is the source of truth (www-7d5b.2.4).
// brightness is HA raw 0..255 to match how the enforcer stores it.
function lampRow(
  id: string,
  entityId: string,
  desired: { on: boolean; brightness?: number; color?: unknown } | null,
  available = true,
) {
  // Default reported = desired so the row reads as converged (pending:false)
  // unless a test deliberately diverges them.
  return makeDeviceRow({
    id,
    entityId,
    kind: "light",
    domain: "light",
    desiredState: desired,
    reportedState: desired,
    available,
  });
}

// A fixture (switch) device row, desired-authoritative.
function fixtureRow(id: string, entityId: string, on: boolean, available = true) {
  return makeDeviceRow({
    id,
    entityId,
    kind: "switch",
    domain: "switch",
    desiredState: { on },
    reportedState: { on },
    available,
  });
}

// The climate thermostat device_state row (www-unxz.2). The fan is read from this
// row's desired.fanMode, desired-authoritative like the lamps. `id` must be the
// CLIMATE_DEVICE_ID the service reads by ("climate-thermostat").
function climateFanRow(
  desiredFanMode: string | null,
  reportedFanMode: string | null,
  available = true,
  mode = "cool",
) {
  return makeDeviceRow({
    id: "climate-thermostat",
    entityId: "climate.home",
    kind: "climate",
    domain: "climate",
    desiredState: desiredFanMode === null ? { mode } : { mode, fanMode: desiredFanMode },
    reportedState: reportedFanMode === null ? { mode } : { mode, fanMode: reportedFanMode },
    available,
  });
}

// Build a minimal caller context for the tRPC router.
function buildCaller() {
  const appRouter = router({ controls: controlsRouter });
  // @ts-expect-error , db not needed by controls procedures (they use global db)
  return appRouter.createCaller({ db: null });
}

/** Seed rows (built via makeDeviceRow/lampRow/fixtureRow/climateFanRow) into an
 * in-memory DeviceStateStore for service-level tests. */
async function seedRows(
  store: DeviceStateStore,
  rows: ReturnType<typeof makeDeviceRow>[],
): Promise<void> {
  for (const row of rows) {
    await store.seed({
      id: row.id,
      kind: row.kind as DeviceKind,
      entityId: row.entityId,
      domain: row.domain,
      label: row.label,
      reported: row.reportedState as never,
      desired: row.desiredState as never,
      available: row.available,
    });
  }
}

// ─── service tests ────────────────────────────────────────────────────────────

describe("getControlsState", () => {
  let store: DeviceStateStore;

  beforeEach(() => {
    vi.resetAllMocks();
    // Lamp/light state is desired-authoritative , HA is read only for the fan
    // (climate). Default: no climate entities.
    mockGetEntities.mockResolvedValue([]);
    // db.select() now only backs the lamp_mode singleton read; empty rows → None.
    mockDbSelect.mockReturnValue(makeSelectChain([]));
    store = createInMemoryDeviceStateStore();
  });

  it("throws when HA is not configured (www-355t.30: THROW-on-unavailable)", async () => {
    mockIsConfigured.mockReturnValue(false);

    await expect(getControlsState(store)).rejects.toThrow("Home Assistant is not configured");
  });

  it("degrades to all-off when the DB is unreachable (desired-authoritative read swallows)", async () => {
    // www-unxz.2: getControlsState makes NO live HA read now (lamps/lights/fan are
    // all desired-authoritative). A DB outage yields no rows → every control reads
    // off/unavailable, matching the established lamp contract (www-7d5b.2.4).
    mockIsConfigured.mockReturnValue(true);
    const listThrowingStore: DeviceStateStore = {
      ...store,
      list: async () => {
        throw new Error("DB unreachable");
      },
    };

    const state = await getControlsState(listThrowingStore);

    expect(state.lamps.on).toBe(false);
    expect(state.lights.on).toBe(false);
    expect(state.fan.on).toBe(false);
    expect(mockGetEntities).not.toHaveBeenCalled();
  });

  it("derives lamp state from DESIRED device rows (source of truth)", async () => {
    mockIsConfigured.mockReturnValue(true);

    await seedRows(store, [
      lampRow("lamp-1", "light.living_room_globe", { on: true }),
      lampRow("lamp-2", "light.bed_lamp_left", { on: true }),
      fixtureRow("fix-1", "switch.overhead_lights", false),
    ]);

    const state = await getControlsState(store);

    expect(state.lamps.on).toBe(true);
    expect(state.lamps.count).toBe(2);
    expect(state.lights.on).toBe(false);
    expect(state.lamps.pending).toBe(false);
  });

  it("reports lamp brightness as the rounded avg pct of on-lamps from desired", async () => {
    mockIsConfigured.mockReturnValue(true);
    // desired brightness is HA raw 0..255: 255 → 100%, 128 → 50%; off lamp excluded.
    await seedRows(store, [
      lampRow("lamp-1", "light.living_room_globe", { on: true, brightness: 255 }),
      lampRow("lamp-2", "light.bed_lamp_left", { on: true, brightness: 128 }),
      lampRow("lamp-3", "light.kitchen_lamp", { on: false, brightness: 64 }),
    ]);

    const state = await getControlsState(store);

    expect(state.lamps.on).toBe(true);
    expect(state.lamps.count).toBe(2);
    expect(state.lamps.brightness).toBe(75);
  });

  it("www-91bl: keeps last-known desired brightness when all lamps are off (bar grays, keeps level)", async () => {
    mockIsConfigured.mockReturnValue(true);
    // Both lamps OFF but desired brightness persists (255→100%, 128→50%): the bar
    // must show the level it will resume to (avg 75%), NOT drop to 0%.
    await seedRows(store, [
      lampRow("lamp-1", "light.living_room_globe", { on: false, brightness: 255 }),
      lampRow("lamp-2", "light.bed_lamp_left", { on: false, brightness: 128 }),
    ]);

    const state = await getControlsState(store);

    expect(state.lamps.on).toBe(false);
    expect(state.lamps.brightness).toBe(75);
  });

  it("www-91bl: brightness is 0 only when no lamp has any known level", async () => {
    mockIsConfigured.mockReturnValue(true);
    // Lamps off with NO brightness ever set → truly unknown → 0 (empty bar is correct).
    await seedRows(store, [
      lampRow("lamp-1", "light.living_room_globe", { on: false }),
      lampRow("lamp-2", "light.bed_lamp_left", { on: false }),
    ]);

    const state = await getControlsState(store);

    expect(state.lamps.on).toBe(false);
    expect(state.lamps.brightness).toBe(0);
  });

  it("never paints an unreachable lamp 'on' even when desired says on (honest availability)", async () => {
    mockIsConfigured.mockReturnValue(true);
    await seedRows(store, [
      lampRow("lamp-1", "light.living_room_globe", { on: true }, /* available */ false),
    ]);

    const state = await getControlsState(store);

    // Desired is on, but the lamp is unreachable → not counted on (tile shimmers).
    expect(state.lamps.on).toBe(false);
    expect(state.lamps.count).toBe(0);
  });

  it("lamps never report pending even when desired has not converged (www-uq58)", async () => {
    mockIsConfigured.mockReturnValue(true);
    await seedRows(store, [
      makeDeviceRow({
        id: "lamp-1",
        entityId: "light.living_room_globe",
        kind: "light",
        domain: "light",
        reportedState: { on: false },
        desiredState: { on: true },
        available: true,
      }),
    ]);

    const state = await getControlsState(store);

    // Effective (desired) is on; reported still off , but lamps are
    // desired-authoritative and never surface a pending cue (www-uq58).
    expect(state.lamps.on).toBe(true);
    expect(state.lamps.pending).toBe(false);
  });

  it("pending:false once reported converges with desired", async () => {
    mockIsConfigured.mockReturnValue(true);
    await seedRows(store, [
      makeDeviceRow({
        id: "lamp-1",
        entityId: "light.living_room_globe",
        kind: "light",
        domain: "light",
        reportedState: { on: true },
        desiredState: { on: true },
        available: true,
      }),
    ]);

    const state = await getControlsState(store);

    expect(state.lamps.pending).toBe(false);
  });

  it("reports fan on from the climate row's desired fan_mode (www-unxz.2), NO HA call", async () => {
    mockIsConfigured.mockReturnValue(true);
    await seedRows(store, [climateFanRow("on", "on")]);

    const state = await getControlsState(store);

    expect(state.fan.on).toBe(true);
    expect(state.fan.sub).toBe("On");
    expect(state.fan.pending).toBe(false);
    expect(mockGetEntities).not.toHaveBeenCalled();
  });

  it("labels fan 'Auto' when fan_mode is auto AND the AC is running (www-pu4m)", async () => {
    mockIsConfigured.mockReturnValue(true);
    // mode cool (running) + fanMode auto → "auto" is meaningful (fan follows demand).
    await seedRows(store, [climateFanRow("auto", "auto", true, "cool")]);

    const state = await getControlsState(store);

    expect(state.fan.on).toBe(false);
    expect(state.fan.sub).toBe("Auto");
  });

  it("labels fan 'Off' when fan_mode is auto AND the AC mode is off (www-pu4m)", async () => {
    mockIsConfigured.mockReturnValue(true);
    // AC off → an "auto" fan is doing nothing, so surface it honestly as Off.
    await seedRows(store, [climateFanRow("auto", "auto", true, "off")]);

    const state = await getControlsState(store);

    expect(state.fan.on).toBe(false);
    expect(state.fan.sub).toBe("Off");
  });

  it("fan pending:true while desired fan_mode has not converged with reported", async () => {
    mockIsConfigured.mockReturnValue(true);
    // Desired on, reported still auto → the fan command is in-flight.
    await seedRows(store, [climateFanRow("on", "auto")]);

    const state = await getControlsState(store);

    expect(state.fan.on).toBe(true);
    expect(state.fan.pending).toBe(true);
  });

  it("www-azw: switch-domain fixtures are visible as 'lights' (from desired)", async () => {
    mockIsConfigured.mockReturnValue(true);
    await seedRows(store, [fixtureRow("fix-1", "switch.overhead_lights", true)]);

    const state = await getControlsState(store);

    expect(state.lights.on).toBe(true);
  });

  it("www-azw: Hue lamps classified as lamps, not fixtures", async () => {
    mockIsConfigured.mockReturnValue(true);
    await seedRows(store, [lampRow("lamp-1", "light.living_room_globe", { on: true })]);

    const state = await getControlsState(store);

    expect(state.lamps.on).toBe(true);
    expect(state.lamps.count).toBe(1);
    expect(state.lights.on).toBe(false);
  });

  it("reports all off when no device rows exist", async () => {
    mockIsConfigured.mockReturnValue(true);

    const state = await getControlsState(store);

    expect(state.lamps.on).toBe(false);
    expect(state.lamps.count).toBe(0);
    expect(state.lamps.sub).toBe("Off");
    expect(state.lights.on).toBe(false);
    expect(state.fan.on).toBe(false);
  });

  // ─── activeScene derivation (from desired colors) ──────────────────────────

  it("activeScene='blue' when every on-lamp's desired color is BLUE_RGB", async () => {
    mockIsConfigured.mockReturnValue(true);
    await seedRows(store, [
      lampRow("lamp-1", "light.living_room_globe", { on: true, color: { rgb: [0, 0, 255] } }),
      lampRow("lamp-2", "light.bed_lamp_left", { on: true, color: { rgb: [0, 0, 255] } }),
    ]);

    const state = await getControlsState(store);

    expect(state.lamps.activeScene).toBe(LampScene.Blue);
  });

  it("activeScene='white' when on-lamps' desired color is WHITE_SCENE_KELVIN", async () => {
    mockIsConfigured.mockReturnValue(true);
    await seedRows(store, [
      lampRow("lamp-1", "light.living_room_globe", {
        on: true,
        color: { kelvin: WHITE_SCENE_KELVIN },
      }),
    ]);

    const state = await getControlsState(store);

    expect(state.lamps.activeScene).toBe(LampScene.White);
  });

  it("activeScene=null when on-lamps disagree on non-palette colors", async () => {
    mockIsConfigured.mockReturnValue(true);
    await seedRows(store, [
      lampRow("lamp-1", "light.living_room_globe", { on: true, color: { rgb: [255, 0, 0] } }),
      lampRow("lamp-2", "light.bed_lamp_left", { on: true, color: { rgb: [0, 0, 255] } }),
    ]);

    const state = await getControlsState(store);

    expect(state.lamps.activeScene).toBeNull();
  });

  it("activeScene='mood' when every on-lamp shows a MOOD_PALETTE color (varied wash, www-vhht)", async () => {
    mockIsConfigured.mockReturnValue(true);
    await seedRows(store, [
      lampRow("lamp-1", "light.living_room_globe", {
        on: true,
        color: { rgb: [...MOOD_PALETTE[0]] },
      }),
      lampRow("lamp-2", "light.bed_lamp_left", { on: true, color: { rgb: [...MOOD_PALETTE[3]] } }),
      lampRow("lamp-3", "light.bed_lamp_right", { on: true, color: { rgb: [...MOOD_PALETTE[5]] } }),
    ]);

    const state = await getControlsState(store);

    expect(state.lamps.activeScene).toBe(LampScene.Mood);
  });

  it("activeScene=null when lamps are off", async () => {
    mockIsConfigured.mockReturnValue(true);
    await seedRows(store, [lampRow("lamp-1", "light.living_room_globe", { on: false })]);

    const state = await getControlsState(store);

    expect(state.lamps.activeScene).toBeNull();
  });
});

// ─── toggleControl tests ──────────────────────────────────────────────────────

describe("toggleControl", () => {
  let store: DeviceStateStore;

  beforeEach(() => {
    vi.resetAllMocks();
    mockCallService.mockResolvedValue(undefined);
    mockGetEntities.mockResolvedValue([]);
    mockDbInsert.mockReturnValue(makeInsertChain());
    mockDbSelect.mockReturnValue(makeSelectChain([]));
    store = createInMemoryDeviceStateStore();
  });

  it("throws when HA is not configured", async () => {
    mockIsConfigured.mockReturnValue(false);

    await expect(toggleControl(ControlKey.Lamps, true, store)).rejects.toThrow(
      "Home Assistant is not configured",
    );
  });

  it("writes desired (on) + command window for every lamp, with NO HA call (www-unxz.1)", async () => {
    mockIsConfigured.mockReturnValue(true);

    await toggleControl(ControlKey.Lamps, true, store);

    // Desired is written (sticky source of truth) for every lamp , the enforcer
    // actuates HA, so the hot path makes NO ha.callService.
    expect(mockCallService).not.toHaveBeenCalled();
    const rows = await store.list();
    const byEntity = new Map(rows.map((r) => [r.entityId, r]));
    for (const entityId of LAMP_ENTITY_IDS) {
      const row = byEntity.get(entityId);
      expect(row?.desiredState).toMatchObject({ on: true });
      // The command window is stamped so the enforcer pushes regardless of policy.
      expect(row?.desiredUntilUtc).toBeInstanceOf(Date);
    }
  });

  it("writes desired (off) for every fixture when toggling lights off, with NO HA call", async () => {
    mockIsConfigured.mockReturnValue(true);

    await toggleControl(ControlKey.Lights, false, store);

    expect(mockCallService).not.toHaveBeenCalled();
    const rows = await store.list();
    const byEntity = new Map(rows.map((r) => [r.entityId, r]));
    for (const entityId of FIXTURE_ENTITY_IDS) {
      expect(byEntity.get(entityId)?.desiredState).toMatchObject({ on: false });
    }
  });

  it("toggling a lamp ON preserves its existing desired color (scene survives a toggle)", async () => {
    mockIsConfigured.mockReturnValue(true);
    // One lamp already has a blue desired color; turning lamps on must keep it.
    await seedRows(store, [
      lampRow("lamp-1", "light.living_room_globe", { on: false, color: { rgb: [0, 0, 255] } }),
    ]);

    await toggleControl(ControlKey.Lamps, true, store);

    // The desired written for the globe carries its preserved color , no HA call.
    expect(mockCallService).not.toHaveBeenCalled();
    const row = await store.read("lamp-1");
    expect(row?.desiredState).toMatchObject({
      on: true,
      color: { rgb: [0, 0, 255] },
    });
  });

  it("toggling the fan ON writes desired.fanMode='on' (+window) on the climate row, NO HA call (www-unxz.2)", async () => {
    mockIsConfigured.mockReturnValue(true);
    // The enforcer has seeded the climate row; the fan write updates its desired.
    await seedRows(store, [climateFanRow("auto", "auto")]);

    await toggleControl(ControlKey.Fan, true, store);

    expect(mockCallService).not.toHaveBeenCalled();
    const row = await store.read("climate-thermostat");
    expect(row?.desiredState).toMatchObject({ fanMode: FanMode.On });
    // The mode is preserved (not clobbered) and a command window is stamped.
    expect((row?.desiredState as { mode?: string })?.mode).toBe("cool");
    expect(row?.desiredUntilUtc).toBeInstanceOf(Date);
  });

  it("toggling the fan OFF writes desired.fanMode='auto', NO HA call", async () => {
    mockIsConfigured.mockReturnValue(true);
    await seedRows(store, [climateFanRow("on", "on")]);

    await toggleControl(ControlKey.Fan, false, store);

    expect(mockCallService).not.toHaveBeenCalled();
    const row = await store.read("climate-thermostat");
    expect(row?.desiredState).toMatchObject({ fanMode: FanMode.Auto });
  });

  it("the fan is a climate fan_mode written to desired, never a device command or HA call", async () => {
    mockIsConfigured.mockReturnValue(true);
    await seedRows(store, [climateFanRow("auto", "auto")]);

    await expect(toggleControl(ControlKey.Fan, true, store)).resolves.toBeDefined();
    expect(mockCallService).not.toHaveBeenCalled();
  });

  it("www-hu8p: clears party mode when turning lamps OFF (party must not resurrect on next on)", async () => {
    mockIsConfigured.mockReturnValue(true);

    await toggleControl(ControlKey.Lamps, false, store);

    expect(mockDbInsert).toHaveBeenCalledWith(lampMode);
  });

  it("www-hu8p: does NOT clear party mode when turning lamps ON (party is durable)", async () => {
    mockIsConfigured.mockReturnValue(true);

    await toggleControl(ControlKey.Lamps, true, store);

    expect(mockDbInsert).not.toHaveBeenCalledWith(lampMode);
  });

  it("propagates a desired-write failure instead of swallowing it (www-unxz.1)", async () => {
    // The desired write is the mutation's only effect , a swallowed DB error would
    // be fabricated success. The store throws; toggleControl lets it propagate.
    mockIsConfigured.mockReturnValue(true);
    const throwingStore: DeviceStateStore = {
      ...store,
      upsertDesired: async () => {
        throw new Error("DB unreachable");
      },
    };

    await expect(toggleControl(ControlKey.Lamps, true, throwingStore)).rejects.toThrow(
      "DB unreachable",
    );
  });

  it("toggling the fan throws when the climate row is not yet seeded (parity with climate mutations)", async () => {
    mockIsConfigured.mockReturnValue(true);

    await expect(toggleControl(ControlKey.Fan, true, store)).rejects.toThrow("no climate state");
  });
});

// ─── router (tRPC caller) tests ───────────────────────────────────────────────

describe("controlsRouter.list", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("throws SERVICE_UNAVAILABLE via tRPC caller when HA is not configured (www-355t.30)", async () => {
    mockIsConfigured.mockReturnValue(false);
    mockDbSelect.mockReturnValue(makeSelectChain([]));

    const caller = buildCaller();
    await expect(caller.controls.list({})).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });

  it("returns controls state via tRPC caller when HA is configured", async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetEntities.mockResolvedValue([]);
    mockDbSelect.mockReturnValue(
      makeSelectChain([lampRow("lamp-1", "light.living_room_globe", { on: true })]),
    );

    const caller = buildCaller();
    const result = await caller.controls.list({});

    expect(result.lamps.on).toBe(true);
    expect(result.lamps.pending).toBe(false);
  });

  it("lamps stay pending:false even when desired has not converged (www-uq58)", async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetEntities.mockResolvedValue([]);

    const row = makeDeviceRow({
      id: "lamp-1",
      entityId: "light.living_room_globe",
      kind: "light",
      domain: "light",
      reportedState: { on: false },
      desiredState: { on: true },
      available: true,
    });
    mockDbSelect.mockReturnValue(makeSelectChain([row]));

    const caller = buildCaller();
    const result = await caller.controls.list({});

    expect(result.lamps.pending).toBe(false);
  });
});

describe("controlsRouter.toggle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCallService.mockResolvedValue(undefined);
  });

  it("returns merged state (not just { success: true }) including pending:true", async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetEntities.mockResolvedValue([makeFan("ceiling", "off")]);
    // The enforcer has seeded the climate row, so the fan write can update it.
    mockDbSelect.mockReturnValue(makeSelectChain([climateFanRow("auto", "auto")]));
    mockDbUpdate.mockImplementation(() => ({
      set: () => ({ where: () => Promise.resolve() }),
    }));

    const caller = buildCaller();
    const result = await caller.controls.toggle({ key: ControlKey.Fan, on: true });

    // Result should be the merged controls state shape, not { success: true }
    expect(result).toHaveProperty("fan");
    expect(result?.fan).toHaveProperty("pending");
    expect(result?.fan).toHaveProperty("on");
  });

  it("throws SERVICE_UNAVAILABLE when HA is not configured", async () => {
    mockIsConfigured.mockReturnValue(false);
    mockDbSelect.mockReturnValue(makeSelectChain([]));

    const caller = buildCaller();
    await expect(caller.controls.toggle({ key: ControlKey.Lamps, on: true })).rejects.toMatchObject(
      {
        code: "SERVICE_UNAVAILABLE",
      },
    );
  });
});

// ─── setLampScene tests ───────────────────────────────────────────────────────

describe("setLampScene", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCallService.mockResolvedValue(undefined);
    mockGetEntities.mockResolvedValue([]);
    mockDbSelect.mockReturnValue(makeSelectChain([]));
    mockDbInsert.mockReturnValue(makeInsertChain());
  });

  it("throws when HA is not configured", async () => {
    mockIsConfigured.mockReturnValue(false);

    await expect(setLampScene(LampScene.White)).rejects.toThrow("Home Assistant is not configured");
  });

  it("writes a uniform white kelvin desired on every lamp, NO HA call (www-unxz.1)", async () => {
    mockIsConfigured.mockReturnValue(true);
    const writes = captureDesiredWrites();

    await setLampScene(LampScene.White);

    expect(writes.size).toBe(LAMP_ENTITY_IDS.length);
    expect(mockCallService).not.toHaveBeenCalled();
    for (const entityId of LAMP_ENTITY_IDS) {
      const desired = writes.get(entityId)?.desiredState as
        | { on: boolean; color?: { kelvin?: number } }
        | undefined;
      expect(desired?.on).toBe(true);
      expect(typeof desired?.color?.kelvin).toBe("number");
    }
  });

  it("writes a uniform red xy desired on every lamp, NO HA call", async () => {
    mockIsConfigured.mockReturnValue(true);
    const writes = captureDesiredWrites();

    await setLampScene(LampScene.Red);

    expect(writes.size).toBe(LAMP_ENTITY_IDS.length);
    expect(mockCallService).not.toHaveBeenCalled();
    for (const entityId of LAMP_ENTITY_IDS) {
      expect(writes.get(entityId)?.desiredState).toMatchObject({
        on: true,
        color: { xy: rgbToXy([255, 0, 0]) },
      });
    }
  });

  it("writes a uniform blue xy desired on every lamp, NO HA call", async () => {
    mockIsConfigured.mockReturnValue(true);
    const writes = captureDesiredWrites();

    await setLampScene(LampScene.Blue);

    expect(mockCallService).not.toHaveBeenCalled();
    for (const entityId of LAMP_ENTITY_IDS) {
      expect(writes.get(entityId)?.desiredState).toMatchObject({
        on: true,
        color: { xy: rgbToXy([0, 0, 255]) },
      });
    }
  });

  it("mood: writes a DIFFERENT xy desired across lamps (varied wash), NO HA call", async () => {
    mockIsConfigured.mockReturnValue(true);
    const writes = captureDesiredWrites();

    await setLampScene(LampScene.Mood);

    expect(writes.size).toBe(LAMP_ENTITY_IDS.length);
    expect(mockCallService).not.toHaveBeenCalled();

    // Collect the desired xy keyed by entity_id.
    const xyByEntity = new Map<string, string>();
    for (const entityId of LAMP_ENTITY_IDS) {
      const desired = writes.get(entityId)?.desiredState as
        | { color?: { xy?: number[] } }
        | undefined;
      expect(desired?.color?.xy).toBeDefined();
      xyByEntity.set(entityId, JSON.stringify(desired?.color?.xy));
    }

    // Every lamp gets a DISTINCT color , no repeats across the room.
    const distinct = new Set(xyByEntity.values());
    expect(distinct.size).toBe(LAMP_ENTITY_IDS.length);

    // Each color must come from the curated palette.
    const paletteSet = new Set(MOOD_PALETTE.map((rgb) => JSON.stringify(rgbToXy(rgb))));
    for (const xy of xyByEntity.values()) {
      expect(paletteSet.has(xy)).toBe(true);
    }
  });

  it("returns the merged controls state after dispatching", async () => {
    mockIsConfigured.mockReturnValue(true);

    const state = await setLampScene(LampScene.White);

    expect(state).toHaveProperty("lamps");
    expect(state).toHaveProperty("lights");
    expect(state).toHaveProperty("fan");
  });

  it("www-hu8p: clears any active party mode so the worker stops overwriting the manual scene", async () => {
    mockIsConfigured.mockReturnValue(true);

    await setLampScene(LampScene.Red);

    // The lamp_mode singleton is upserted (to 'none') so party yields the color.
    expect(mockDbInsert).toHaveBeenCalledWith(lampMode);
  });
});

// ─── setLampBrightness tests ──────────────────────────────────────────────────

describe("setLampBrightness", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCallService.mockResolvedValue(undefined);
    mockGetEntities.mockResolvedValue([]);
    mockDbSelect.mockReturnValue(makeSelectChain([]));
    mockDbInsert.mockReturnValue(makeInsertChain());
  });

  it("throws when HA is not configured", async () => {
    mockIsConfigured.mockReturnValue(false);

    await expect(setLampBrightness(50)).rejects.toThrow("Home Assistant is not configured");
  });

  it("writes raw brightness (0..255) desired on every lamp, NO HA call (www-unxz.1)", async () => {
    mockIsConfigured.mockReturnValue(true);
    const writes = captureDesiredWrites();

    // 60% → round(0.6 * 255) = 153. Desired stores HA raw, matching what the
    // enforcer re-asserts on drift.
    await setLampBrightness(60);

    expect(mockDbInsert).toHaveBeenCalledTimes(LAMP_ENTITY_IDS.length);
    expect(mockCallService).not.toHaveBeenCalled();
    for (const entityId of LAMP_ENTITY_IDS) {
      expect(writes.get(entityId)?.desiredState).toMatchObject({ on: true, brightness: 153 });
    }
  });

  it("clamps brightness above 100 down to 100 (raw 255)", async () => {
    mockIsConfigured.mockReturnValue(true);
    const writes = captureDesiredWrites();

    await setLampBrightness(150);

    expect(writes.get(LAMP_ENTITY_IDS[0])?.desiredState).toMatchObject({ brightness: 255 });
  });

  it("clamps negative brightness up to 0 (raw 0)", async () => {
    mockIsConfigured.mockReturnValue(true);
    const writes = captureDesiredWrites();

    await setLampBrightness(-20);

    expect(writes.get(LAMP_ENTITY_IDS[0])?.desiredState).toMatchObject({ brightness: 0 });
  });

  it("returns the merged controls state after dispatching", async () => {
    mockIsConfigured.mockReturnValue(true);

    const state = await setLampBrightness(75);

    expect(state).toHaveProperty("lamps");
  });

  it("www-hu8p: does NOT clear party mode (dimming is allowed during party)", async () => {
    mockIsConfigured.mockReturnValue(true);

    await setLampBrightness(50);

    expect(mockDbInsert).not.toHaveBeenCalledWith(lampMode);
  });
});

// ─── router: setLampScene / setLampBrightness ─────────────────────────────────

describe("controlsRouter.setLampScene", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCallService.mockResolvedValue(undefined);
    mockGetEntities.mockResolvedValue([]);
    mockDbSelect.mockReturnValue(makeSelectChain([]));
    mockDbInsert.mockReturnValue(makeInsertChain());
  });

  it("returns merged controls state via tRPC caller", async () => {
    mockIsConfigured.mockReturnValue(true);

    const caller = buildCaller();
    const result = await caller.controls.setLampScene({ scene: "mood" });

    expect(result).toHaveProperty("lamps");
  });

  it("throws SERVICE_UNAVAILABLE when HA is not configured", async () => {
    mockIsConfigured.mockReturnValue(false);

    const caller = buildCaller();
    await expect(caller.controls.setLampScene({ scene: "white" })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
});

describe("controlsRouter.setLampBrightness", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCallService.mockResolvedValue(undefined);
    mockGetEntities.mockResolvedValue([]);
    mockDbSelect.mockReturnValue(makeSelectChain([]));
    mockDbInsert.mockReturnValue(makeInsertChain());
  });

  it("returns merged controls state via tRPC caller", async () => {
    mockIsConfigured.mockReturnValue(true);

    const caller = buildCaller();
    const result = await caller.controls.setLampBrightness({ pct: 40 });

    expect(result).toHaveProperty("lamps");
  });

  it("throws SERVICE_UNAVAILABLE when HA is not configured", async () => {
    mockIsConfigured.mockReturnValue(false);

    const caller = buildCaller();
    await expect(caller.controls.setLampBrightness({ pct: 40 })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
});

// ─── setLampMode + activeScene='party' (www-7d5b.3.4) ──────────────────────────

describe("setLampMode", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCallService.mockResolvedValue(undefined);
    mockGetEntities.mockResolvedValue([]);
    mockDbInsert.mockReturnValue(makeInsertChain());
  });

  it("throws when HA is not configured", async () => {
    mockIsConfigured.mockReturnValue(false);
    mockDbSelect.mockReturnValue(makeSelectChain([]));

    await expect(setLampMode(LampMode.Party)).rejects.toThrow("Home Assistant is not configured");
  });

  it("writes the lamp_mode row when starting party with a lamp on", async () => {
    mockIsConfigured.mockReturnValue(true);
    // A lamp is on (desired), so party is allowed; row is written.
    mockSelectWithMode(
      [lampRow("lamp-1", "light.living_room_globe", { on: true })],
      LampMode.Party,
    );

    await setLampMode(LampMode.Party, LampModeSpeed.Fast);

    // The singleton row is upserted (one insert) , the worker reconciles it.
    expect(mockDbInsert).toHaveBeenCalledTimes(1);
  });

  it("no-ops (no row write) when starting party with NO lamps on", async () => {
    mockIsConfigured.mockReturnValue(true);
    // All lamps off → nothing to animate; the row must NOT be written.
    mockSelectWithMode(
      [lampRow("lamp-1", "light.living_room_globe", { on: false })],
      LampMode.None,
    );

    await setLampMode(LampMode.Party);

    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it("writes mode='none' even when no lamps are on (clearing is always allowed)", async () => {
    mockIsConfigured.mockReturnValue(true);
    mockSelectWithMode(
      [lampRow("lamp-1", "light.living_room_globe", { on: false })],
      LampMode.None,
    );

    await setLampMode(LampMode.None);

    expect(mockDbInsert).toHaveBeenCalledTimes(1);
  });

  it("returns the merged controls state after setting the mode", async () => {
    mockIsConfigured.mockReturnValue(true);
    mockSelectWithMode(
      [lampRow("lamp-1", "light.living_room_globe", { on: true })],
      LampMode.Party,
    );

    const state = await setLampMode(LampMode.Party);

    expect(state).toHaveProperty("lamps");
    expect(state).toHaveProperty("lights");
    expect(state).toHaveProperty("fan");
  });
});

describe("getControlsState activeScene='party'", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetEntities.mockResolvedValue([]);
  });

  it("reports activeScene='party' when the lamp_mode row is party (overriding color)", async () => {
    mockIsConfigured.mockReturnValue(true);
    // Lamps are blue, but the party mode row overrides the color-derived scene.
    mockSelectWithMode(
      [lampRow("lamp-1", "light.living_room_globe", { on: true, color: { rgb: [0, 0, 255] } })],
      LampMode.Party,
    );

    const state = await getControlsState();

    expect(state.lamps.activeScene).toBe(LampMode.Party);
  });

  it("falls back to the color-derived scene when the lamp_mode row is none", async () => {
    mockIsConfigured.mockReturnValue(true);
    mockSelectWithMode(
      [lampRow("lamp-1", "light.living_room_globe", { on: true, color: { rgb: [0, 0, 255] } })],
      LampMode.None,
    );

    const state = await getControlsState();

    expect(state.lamps.activeScene).toBe(LampScene.Blue);
  });
});

describe("controlsRouter.setLampMode", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCallService.mockResolvedValue(undefined);
    mockGetEntities.mockResolvedValue([]);
    mockDbInsert.mockReturnValue(makeInsertChain());
  });

  it("returns merged controls state via tRPC caller (activeScene='party')", async () => {
    mockIsConfigured.mockReturnValue(true);
    mockSelectWithMode(
      [lampRow("lamp-1", "light.living_room_globe", { on: true })],
      LampMode.Party,
    );

    const caller = buildCaller();
    const result = await caller.controls.setLampMode({ mode: "party", speed: "medium" });

    expect(result).toHaveProperty("lamps");
    expect(result.lamps.activeScene).toBe(LampMode.Party);
  });

  it("accepts mode='none' with no speed", async () => {
    mockIsConfigured.mockReturnValue(true);
    mockSelectWithMode([], LampMode.None);

    const caller = buildCaller();
    const result = await caller.controls.setLampMode({ mode: "none" });

    expect(result).toHaveProperty("lamps");
  });

  it("throws SERVICE_UNAVAILABLE when HA is not configured", async () => {
    mockIsConfigured.mockReturnValue(false);
    mockDbSelect.mockReturnValue(makeSelectChain([]));

    const caller = buildCaller();
    await expect(caller.controls.setLampMode({ mode: "party" })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
});
