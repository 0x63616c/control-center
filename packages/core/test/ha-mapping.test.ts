import { describe, expect, it } from "vitest";

import { mapHaToReported, stateEquals } from "../src/device-state/ha-mapping";

describe("mapHaToReported", () => {
  it("returns { reported: null, available: false } when entity is undefined", () => {
    const result = mapHaToReported("light", undefined);
    expect(result).toEqual({ reported: null, available: false });
  });

  it("returns { on: true } for light entity with state='on'", () => {
    const result = mapHaToReported("light", {
      entity_id: "light.lamp",
      state: "on",
      attributes: {},
      last_updated: new Date().toISOString(),
    });
    expect(result.available).toBe(true);
    expect(result.reported).toEqual({ on: true });
  });

  it("returns { on: false } for light entity with state='off'", () => {
    const result = mapHaToReported("light", {
      entity_id: "light.lamp",
      state: "off",
      attributes: {},
      last_updated: new Date().toISOString(),
    });
    expect(result.available).toBe(true);
    expect(result.reported).toEqual({ on: false });
  });

  it("includes brightness when present on a light entity", () => {
    const result = mapHaToReported("light", {
      entity_id: "light.lamp",
      state: "on",
      attributes: { brightness: 128 },
      last_updated: new Date().toISOString(),
    });
    expect(result.reported).toEqual({ on: true, brightness: 128 });
  });

  it("includes rgb color when rgb_color is present", () => {
    const result = mapHaToReported("light", {
      entity_id: "light.lamp",
      state: "on",
      attributes: { brightness: 200, rgb_color: [255, 0, 0] },
      last_updated: new Date().toISOString(),
    });
    expect(result.reported).toEqual({ on: true, brightness: 200, color: { rgb: [255, 0, 0] } });
  });

  it("includes kelvin color when color_temp_kelvin is present and no rgb", () => {
    const result = mapHaToReported("light", {
      entity_id: "light.lamp",
      state: "on",
      attributes: { color_temp_kelvin: 4000 },
      last_updated: new Date().toISOString(),
    });
    expect(result.reported).toEqual({ on: true, color: { kelvin: 4000 } });
  });

  it("uses active color_temp instead of Home Assistant's derived color representations", () => {
    const result = mapHaToReported("light", {
      entity_id: "light.lamp",
      state: "on",
      attributes: {
        color_mode: "color_temp",
        supported_color_modes: ["color_temp", "xy"],
        color_temp_kelvin: 4000,
        rgb_color: [255, 206, 166],
        xy_color: [0.42, 0.365],
        hs_color: [26.812, 34.87],
      },
      last_updated: new Date().toISOString(),
    });
    expect(result.reported).toEqual({ on: true, color: { kelvin: 4000 } });
  });

  it("uses active xy instead of Home Assistant's derived RGB representation", () => {
    const result = mapHaToReported("light", {
      entity_id: "light.lamp",
      state: "on",
      attributes: {
        color_mode: "xy",
        supported_color_modes: ["color_temp", "xy"],
        xy_color: [0.701, 0.299],
        rgb_color: [255, 0, 0],
      },
      last_updated: new Date().toISOString(),
    });
    expect(result.reported).toEqual({ on: true, color: { xy: [0.701, 0.299] } });
  });

  it("omits color when rgb_color is malformed", () => {
    const result = mapHaToReported("light", {
      entity_id: "light.lamp",
      state: "on",
      attributes: { rgb_color: [255, 0] },
      last_updated: new Date().toISOString(),
    });
    expect(result.reported).toEqual({ on: true });
  });

  it("returns { reported: null, available: false } for unavailable entity", () => {
    const result = mapHaToReported("light", {
      entity_id: "light.lamp",
      state: "unavailable",
      attributes: {},
      last_updated: new Date().toISOString(),
    });
    expect(result).toEqual({ reported: null, available: false });
  });

  it("returns { reported: null, available: false } for unknown entity", () => {
    const result = mapHaToReported("light", {
      entity_id: "light.lamp",
      state: "unknown",
      attributes: {},
      last_updated: new Date().toISOString(),
    });
    expect(result).toEqual({ reported: null, available: false });
  });

  it("returns available but null reported for an unknown kind", () => {
    const result = mapHaToReported("sensor", {
      entity_id: "sensor.temp",
      state: "72",
      attributes: {},
      last_updated: new Date().toISOString(),
    });
    expect(result.available).toBe(true);
    expect(result.reported).toBeNull();
  });

  it("maps a climate entity to reported climate state (ambient/action reported-only) , www-unxz.2", () => {
    const result = mapHaToReported("climate", {
      entity_id: "climate.home",
      state: "cool",
      attributes: {
        hvac_mode: "cool",
        temperature: 70,
        fan_mode: "on",
        current_temperature: 73,
        hvac_action: "cooling",
      },
      last_updated: new Date().toISOString(),
    });
    expect(result.available).toBe(true);
    expect(result.reported).toMatchObject({
      mode: "cool",
      target: 70,
      fanMode: "on",
      ambient: 73,
      action: "cooling",
    });
  });
});

describe("stateEquals", () => {
  it("returns true for two identical { on: true, brightness: 128 } values", () => {
    expect(stateEquals({ on: true, brightness: 128 }, { on: true, brightness: 128 })).toBe(true);
  });

  it("returns false when on differs", () => {
    expect(stateEquals({ on: true }, { on: false })).toBe(false);
  });

  it("returns false when brightness differs", () => {
    expect(stateEquals({ on: true, brightness: 100 }, { on: true, brightness: 200 })).toBe(false);
  });

  it("returns true when both are null", () => {
    expect(stateEquals(null, null)).toBe(true);
  });

  it("returns false when one is null", () => {
    expect(stateEquals({ on: true }, null)).toBe(false);
    expect(stateEquals(null, { on: false })).toBe(false);
  });

  it("returns true when brightness is absent on both", () => {
    expect(stateEquals({ on: true }, { on: true })).toBe(true);
  });

  it("returns false when rgb color differs", () => {
    expect(
      stateEquals(
        { on: true, color: { rgb: [255, 0, 0] } },
        { on: true, color: { rgb: [0, 0, 255] } },
      ),
    ).toBe(false);
  });

  it("returns true when rgb color matches", () => {
    expect(
      stateEquals({ on: true, color: { rgb: [1, 2, 3] } }, { on: true, color: { rgb: [1, 2, 3] } }),
    ).toBe(true);
  });

  it("returns false when kelvin differs", () => {
    expect(
      stateEquals({ on: true, color: { kelvin: 4000 } }, { on: true, color: { kelvin: 2700 } }),
    ).toBe(false);
  });

  it("returns false when one has color and the other does not", () => {
    expect(stateEquals({ on: true, color: { rgb: [1, 2, 3] } }, { on: true })).toBe(false);
  });
});
