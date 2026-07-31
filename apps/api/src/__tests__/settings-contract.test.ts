/**
 * Guards the settings CONTRACT , the shared module (../contract/settings) that
 * the api's zod schema and the web store both derive from.
 *
 * The point is not to re-test zod. It is that these two sides used to declare
 * the same vocabulary and bounds independently, and had already drifted (web
 * clamped the idle timeout to 10 min while this schema accepted 60). These tests
 * fail if someone reintroduces a literal here instead of importing the contract.
 */

import { describe, expect, it } from "vitest";

import {
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  DIM_MAX,
  DIM_MIN,
  LOCK_SCREEN_BLUR_MAX_PERCENT,
  LOCK_SCREEN_BLUR_MIN_PERCENT,
  SETTINGS_DEFAULTS,
  SNAP_MODES,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
} from "../contract/settings";
import { DEFAULTS, settingsSchema } from "../services/settings-service";

describe("settings contract", () => {
  it("accepts every snap mode the web picker can offer", () => {
    // The picker is built by mapping SNAP_MODES, so a mode the schema rejects is
    // a mode the user can select and then fail to save.
    for (const mode of SNAP_MODES) {
      expect(settingsSchema.parse({ ...DEFAULTS, snapMode: mode }).snapMode).toBe(mode);
    }
  });

  it("rejects a snap mode outside the contract", () => {
    expect(() => settingsSchema.parse({ ...DEFAULTS, snapMode: "magnetic" })).toThrow();
  });

  it("validates its own defaults", () => {
    // DEFAULTS is the merge floor for every read and write; if it did not parse,
    // getSettings would throw on a fresh install.
    expect(settingsSchema.parse(DEFAULTS)).toEqual(DEFAULTS);
    expect(DEFAULTS).toBe(SETTINGS_DEFAULTS);
  });

  it("enforces the shared timeout window on the idle-dim timeout field", () => {
    for (const field of ["idleDimTimeoutMs"] as const) {
      expect(settingsSchema.parse({ ...DEFAULTS, [field]: TIMEOUT_MIN_MS })[field]).toBe(
        TIMEOUT_MIN_MS,
      );
      expect(settingsSchema.parse({ ...DEFAULTS, [field]: TIMEOUT_MAX_MS })[field]).toBe(
        TIMEOUT_MAX_MS,
      );
      expect(() => settingsSchema.parse({ ...DEFAULTS, [field]: TIMEOUT_MIN_MS - 1 })).toThrow();
      // The ceiling is what the web slider offers. It used to be an hour here,
      // which meant the server would happily store a value the panel could not
      // produce or display.
      expect(() => settingsSchema.parse({ ...DEFAULTS, [field]: TIMEOUT_MAX_MS + 1 })).toThrow();
    }
  });

  it("enforces the shared brightness and dim bounds", () => {
    expect(() =>
      settingsSchema.parse({ ...DEFAULTS, activeBrightness: BRIGHTNESS_MAX + 0.01 }),
    ).toThrow();
    expect(() =>
      settingsSchema.parse({ ...DEFAULTS, activeBrightness: BRIGHTNESS_MIN - 0.001 }),
    ).toThrow();
    // Dim stays strictly below full so "dimmed" always reads darker than "awake".
    expect(() => settingsSchema.parse({ ...DEFAULTS, idleDimLevel: DIM_MAX + 0.01 })).toThrow();
    expect(() => settingsSchema.parse({ ...DEFAULTS, idleDimLevel: DIM_MIN - 0.001 })).toThrow();
    expect(DIM_MAX).toBeLessThan(BRIGHTNESS_MAX);
  });

  it("enforces the lock-screen blur percentage contract", () => {
    expect(
      settingsSchema.parse({ ...DEFAULTS, lockScreenBlurPercent: LOCK_SCREEN_BLUR_MIN_PERCENT }),
    ).toMatchObject({ lockScreenBlurPercent: 0 });
    expect(
      settingsSchema.parse({ ...DEFAULTS, lockScreenBlurPercent: LOCK_SCREEN_BLUR_MAX_PERCENT }),
    ).toMatchObject({ lockScreenBlurPercent: 100 });
    expect(() => settingsSchema.parse({ ...DEFAULTS, lockScreenBlurPercent: -1 })).toThrow();
    expect(() => settingsSchema.parse({ ...DEFAULTS, lockScreenBlurPercent: 101 })).toThrow();
  });
});
