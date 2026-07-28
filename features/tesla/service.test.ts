import type { HaEntity } from "@www/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @www/core's createHomeAssistantClient before importing the service ,
// the feature builds its own HA client instance from its config slice
// (P1.1 hoist), so the mock target is the client factory, not an api-side
// singleton import.
// vi.mock is hoisted above module-level const declarations, so mockHa must be
// created via vi.hoisted to be visible inside the factory below.
const mockHa = vi.hoisted(() => ({
  isConfigured: vi.fn(() => false),
  getEntity: vi.fn(async (_id: string): Promise<HaEntity | undefined> => undefined),
  callService: vi.fn(
    async (_domain: string, _service: string, _data?: Record<string, unknown>) => undefined,
  ),
}));
vi.mock("@www/core", async () => {
  const actual = await vi.importActual<typeof import("@www/core")>("@www/core");
  return {
    ...actual,
    createHomeAssistantClient: vi.fn(() => mockHa),
  };
});

import { findPlace, haversineMiles, PLACES } from "./places";
import {
  ChargeState,
  getTeslaData,
  LockState,
  setTeslaCharging,
  setTeslaLock,
  setTeslaPreconditioning,
} from "./service";

function makeEntity(
  entity_id: string,
  state: string,
  attributes: Record<string, unknown> = {},
): HaEntity {
  return { entity_id, state, attributes, last_updated: "2024-01-01T00:00:00Z" };
}

/** Build a getEntity mock from an entity_id -> entity map (rejects unknown ids). */
function mockStates(states: Record<string, HaEntity>) {
  mockHa.getEntity.mockImplementation(async (id: string) => {
    const e = states[id];
    if (!e) throw new Error(`404 ${id}`);
    return e;
  });
}

// Real "Evee" entity ids (Tesla Fleet integration, evee_ prefix).
const E = "sensor.evee_battery_level";
const fullCar: Record<string, HaEntity> = {
  "sensor.evee_battery_level": makeEntity(E, "61"),
  "sensor.evee_charging": makeEntity("sensor.evee_charging", ChargeState.Charging, {
    options: Object.values(ChargeState),
  }),
  "sensor.evee_charge_rate": makeEntity("sensor.evee_charge_rate", "25"),
  "sensor.evee_battery_range": makeEntity("sensor.evee_battery_range", "169.37"),
  "sensor.evee_inside_temperature": makeEntity("sensor.evee_inside_temperature", "71.96"),
  "lock.evee_lock": makeEntity("lock.evee_lock", LockState.Locked),
  "device_tracker.evee_location": makeEntity("device_tracker.evee_location", "home", {
    latitude: 34.0537,
    longitude: -118.2428,
    source_type: "gps",
  }),
  "climate.evee_climate": makeEntity("climate.evee_climate", "heat_cool"),
};

describe("getTeslaData", () => {
  beforeEach(() => {
    mockHa.isConfigured.mockReturnValue(false);
    mockStates({}); // default: every entity lookup rejects
  });

  it("throws when HA is not configured", async () => {
    mockHa.isConfigured.mockReturnValue(false);
    await expect(getTeslaData()).rejects.toThrow("Home Assistant is not configured");
  });

  it("throws when the battery entity is missing (car asleep/all entities 404)", async () => {
    mockHa.isConfigured.mockReturnValue(true);
    mockStates({}); // every getEntity rejects , allSettled skips them all
    await expect(getTeslaData()).rejects.toThrow("unavailable");
  });

  it("throws when the car is asleep (battery state is unavailable)", async () => {
    mockHa.isConfigured.mockReturnValue(true);
    mockStates({ "sensor.evee_battery_level": makeEntity(E, "unavailable") });
    await expect(getTeslaData()).rejects.toThrow("unavailable");
  });

  it("maps the real Evee entities to TeslaData", async () => {
    mockHa.isConfigured.mockReturnValue(true);
    mockStates(fullCar);
    const data = await getTeslaData();
    expect(data.name).toBe("Model Y");
    expect(data.nick).toBe("Evee");
    expect(data.pct).toBe(61);
    expect(data.charging).toBe(true);
    expect(data.chargingState).toBe(ChargeState.Charging); // raw enum surfaced verbatim
    expect(data.preconditioning).toBe(true); // hvac mode is heat_cool -> active
    expect(data.rate).toBe(25);
    expect(data.range).toBe(169); // rounded
    expect(data.climate).toBe(72); // 71.96 rounded
    expect(data.locked).toBe(true);
    expect(data.lat).toBeCloseTo(34.0537);
    expect(data.lon).toBeCloseTo(-118.2428);
    expect(data.place).toBe("Home"); // GPS within home radius -> named place
    // Odometer entity is disabled in the integration -> honest "," absence.
    expect(data.odo).toBe(",");
  });

  it("treats only 'charging'/'starting' as charging", async () => {
    mockHa.isConfigured.mockReturnValue(true);
    mockStates({
      ...fullCar,
      "sensor.evee_charging": makeEntity("sensor.evee_charging", ChargeState.Disconnected),
    });
    expect((await getTeslaData()).charging).toBe(false);
  });

  it("maps unlocked state", async () => {
    mockHa.isConfigured.mockReturnValue(true);
    mockStates({ ...fullCar, "lock.evee_lock": makeEntity("lock.evee_lock", LockState.Unlocked) });
    expect((await getTeslaData()).locked).toBe(false);
  });

  it("uses the real odometer when present, formatted with commas", async () => {
    mockHa.isConfigured.mockReturnValue(true);
    mockStates({
      ...fullCar,
      "sensor.evee_odometer": makeEntity("sensor.evee_odometer", "24113.4"),
    });
    expect((await getTeslaData()).odo).toBe("24,113");
  });

  it("shows ',' (not 0) when the odometer entity reads unknown", async () => {
    // The odometer entity exists but the car is asleep, so it reports
    // "unknown" , must show honest "," absence, never a bogus "0".
    mockHa.isConfigured.mockReturnValue(true);
    mockStates({
      ...fullCar,
      "sensor.evee_odometer": makeEntity("sensor.evee_odometer", "unknown"),
    });
    expect((await getTeslaData()).odo).toBe(",");
  });

  it("titlecases a non-home zone as the place", async () => {
    mockHa.isConfigured.mockReturnValue(true);
    mockStates({
      ...fullCar,
      "device_tracker.evee_location": makeEntity(
        "device_tracker.evee_location",
        "sound_nightclub",
        {
          latitude: 34.09,
          longitude: -118.33,
        },
      ),
    });
    const data = await getTeslaData();
    expect(data.place).toBe("Sound Nightclub");
    expect(data.lat).toBeCloseTo(34.09);
  });

  it("defaults to 0 range when range sensor is unavailable but battery is live", async () => {
    mockHa.isConfigured.mockReturnValue(true);
    mockStates({
      "sensor.evee_battery_level": makeEntity(E, "55"),
      "sensor.evee_battery_range": makeEntity("sensor.evee_battery_range", "unavailable"),
    });
    const data = await getTeslaData();
    expect(data.pct).toBe(55);
    expect(data.range).toBe(0); // numeric zero , honest sensor gap, not fabricated
    expect(data.charging).toBe(false); // no charging entity -> default false
    expect(data.chargingState).toBe(""); // no charging entity -> empty (honest absence)
    expect(data.preconditioning).toBe(false); // no hvac entity -> not preconditioning
    expect(data.place).toBe(""); // no tracker, no coords -> unknown location, no fabricated label
  });

  it("surfaces the raw charging enum verbatim (stopped/complete/disconnected)", async () => {
    mockHa.isConfigured.mockReturnValue(true);
    mockStates({
      ...fullCar,
      "sensor.evee_charging": makeEntity("sensor.evee_charging", ChargeState.Complete),
    });
    const data = await getTeslaData();
    expect(data.chargingState).toBe(ChargeState.Complete);
    expect(data.charging).toBe(false); // complete is not actively charging
  });

  it("blanks chargingState when the charging entity is dead", async () => {
    mockHa.isConfigured.mockReturnValue(true);
    mockStates({
      ...fullCar,
      "sensor.evee_charging": makeEntity("sensor.evee_charging", "unavailable"),
    });
    expect((await getTeslaData()).chargingState).toBe("");
  });

  it("reports preconditioning false when the hvac entity is off", async () => {
    mockHa.isConfigured.mockReturnValue(true);
    mockStates({
      ...fullCar,
      "climate.evee_climate": makeEntity("climate.evee_climate", "off"),
    });
    expect((await getTeslaData()).preconditioning).toBe(false);
  });

  it("reports preconditioning false when the hvac entity is dead/absent", async () => {
    mockHa.isConfigured.mockReturnValue(true);
    mockStates({
      ...fullCar,
      "climate.evee_climate": makeEntity("climate.evee_climate", "unavailable"),
    });
    expect((await getTeslaData()).preconditioning).toBe(false);
  });
});

describe("tesla mutations", () => {
  beforeEach(() => {
    mockHa.isConfigured.mockReturnValue(true);
    mockHa.callService.mockClear();
  });

  it("setTeslaLock calls lock.lock / lock.unlock on the real entity", async () => {
    await setTeslaLock(true);
    expect(mockHa.callService).toHaveBeenCalledWith("lock", "lock", {
      entity_id: "lock.evee_lock",
    });
    await setTeslaLock(false);
    expect(mockHa.callService).toHaveBeenCalledWith("lock", "unlock", {
      entity_id: "lock.evee_lock",
    });
  });

  it("setTeslaCharging toggles the charger switch", async () => {
    await setTeslaCharging(true);
    expect(mockHa.callService).toHaveBeenCalledWith("switch", "turn_on", {
      entity_id: "switch.evee_charge",
    });
    await setTeslaCharging(false);
    expect(mockHa.callService).toHaveBeenCalledWith("switch", "turn_off", {
      entity_id: "switch.evee_charge",
    });
  });

  it("setTeslaPreconditioning turns the hvac climate entity on/off", async () => {
    await setTeslaPreconditioning(true);
    expect(mockHa.callService).toHaveBeenCalledWith("climate", "turn_on", {
      entity_id: "climate.evee_climate",
    });
    await setTeslaPreconditioning(false);
    expect(mockHa.callService).toHaveBeenCalledWith("climate", "turn_off", {
      entity_id: "climate.evee_climate",
    });
  });

  it("mutations throw when HA is not configured", async () => {
    mockHa.isConfigured.mockReturnValue(false);
    await expect(setTeslaLock(true)).rejects.toThrow("not configured");
    await expect(setTeslaCharging(true)).rejects.toThrow("not configured");
    await expect(setTeslaPreconditioning(true)).rejects.toThrow("not configured");
  });

  it("resolves the named place when GPS is within radius even off a non-home zone", async () => {
    // Car physically at home but HA reports a stale/other zone state , GPS wins.
    mockHa.isConfigured.mockReturnValue(true);
    mockStates({
      ...fullCar,
      "device_tracker.evee_location": makeEntity("device_tracker.evee_location", "not_home", {
        latitude: 34.0537,
        longitude: -118.2428,
      }),
    });
    expect((await getTeslaData()).place).toBe("Home");
  });
});

describe("haversineMiles", () => {
  it("is ~0 for identical points", () => {
    expect(haversineMiles(34.0537, -118.2428, 34.0537, -118.2428)).toBeCloseTo(0, 5);
  });

  it("computes a known short distance (~0.95mi across central LA)", () => {
    // 34.0537,-118.2428 -> 34.0537,-118.2262 is ~0.95mi due east.
    const d = haversineMiles(34.0537, -118.2428, 34.0537, -118.2262);
    expect(d).toBeGreaterThan(0.9);
    expect(d).toBeLessThan(1.0);
  });

  it("is symmetric", () => {
    const a = haversineMiles(34.0537, -118.2428, 34.09, -118.33);
    const b = haversineMiles(34.09, -118.33, 34.0537, -118.2428);
    expect(a).toBeCloseTo(b, 6);
  });
});

describe("findPlace", () => {
  it("matches the configured home place within its radius", () => {
    // PLACES is built from the HOME_* env; with the public test defaults that is
    // { name: "Home", lat: 34.0537, lon: -118.2428, radiusMiles: 1 }.
    expect(findPlace(34.0537, -118.2428)?.name).toBe("Home");
  });

  it("returns undefined when outside every place radius", () => {
    // ~3mi north-west of the configured home, outside the 1mi radius.
    expect(findPlace(34.09, -118.33)).toBeUndefined();
  });

  it("returns the first matching place (order is priority)", () => {
    // The point exactly at the first place must resolve to that first place.
    const first = PLACES[0];
    expect(findPlace(first.lat, first.lon)?.name).toBe(first.name);
  });
});
