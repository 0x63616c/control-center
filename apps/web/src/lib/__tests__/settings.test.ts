import { SETTINGS_DEFAULTS } from "@cc/api/settings";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PIN,
  hydrateSettings,
  MAX_IDLE_TIMEOUT_MS,
  PIN_LENGTH,
  resetSettings,
  setAccent,
  setPinCode,
  setPinPadLayout,
  setShowMinimap,
  setTypeface,
  useSettings,
} from "../settings";

// The store is a module-level singleton; reset it after each test so cases don't
// leak state into one another.
afterEach(() => {
  act(() => resetSettings());
});

function read() {
  return renderHook(() => useSettings()).result;
}

describe("settings defaults", () => {
  it("includes the minimap + PIN fields at their defaults", () => {
    act(() => resetSettings());
    const s = read().current;
    expect(s.showMinimap).toBe(true);
    expect(s.pinCode).toBe("000000");
    // The pad moves out of the box (#287/#291) , see the api-side default.
    expect(s.pinPadLayout).toBe("scrambled");
  });

  it("defaults showBuildNumber to false (opt-in, native-only)", () => {
    act(() => resetSettings());
    expect(read().current.showBuildNumber).toBe(false);
  });

  it("exports PIN_LENGTH = 6 and DEFAULT_PIN = 000000", () => {
    expect(PIN_LENGTH).toBe(6);
    expect(DEFAULT_PIN).toBe("000000");
  });

  it("caps the idle timeout at 10 minutes", () => {
    expect(MAX_IDLE_TIMEOUT_MS).toBe(600_000);
  });
});

describe("setPinCode", () => {
  it("accepts an exactly-6-digit code", () => {
    act(() => setPinCode("123456"));
    expect(read().current.pinCode).toBe("123456");
  });

  it("ignores a non-numeric code", () => {
    act(() => setPinCode("123456"));
    act(() => setPinCode("12x456"));
    expect(read().current.pinCode).toBe("123456");
  });

  it("ignores a too-short code", () => {
    act(() => setPinCode("123456"));
    act(() => setPinCode("12345"));
    expect(read().current.pinCode).toBe("123456");
  });

  it("ignores a too-long code", () => {
    act(() => setPinCode("123456"));
    act(() => setPinCode("1234567"));
    expect(read().current.pinCode).toBe("123456");
  });
});

describe("resetSettings", () => {
  it("restores pinCode to the default", () => {
    act(() => setPinCode("123456"));
    act(() => resetSettings());
    expect(read().current.pinCode).toBe("000000");
  });
});

describe("minimap setter", () => {
  it("toggles showMinimap", () => {
    act(() => setShowMinimap(false));
    expect(read().current.showMinimap).toBe(false);
  });
});

describe("pin-pad-layout setter", () => {
  it("stores a chosen layout", () => {
    act(() => setPinPadLayout("rotated"));
    expect(read().current.pinPadLayout).toBe("rotated");
  });

  // It is a SYNCED setting, not device-local: how the installation is locked is
  // one decision, not a per-panel one. Hydration must therefore reach it.
  it("accepts pinPadLayout from the server", () => {
    act(() => hydrateSettings({ pinPadLayout: "fixed" }));
    expect(read().current.pinPadLayout).toBe("fixed");
  });
});

describe("accent setter", () => {
  it("stores a chosen accent", () => {
    act(() => setAccent("green"));
    expect(read().current.accent).toBe("green");
  });

  // Asserts against the CONTRACT's default rather than a literal: the baseline
  // is a product decision that has already moved once (blue -> white), and a
  // hardcoded colour here would fail the next time it moves for the wrong reason.
  it("resets to the default accent", () => {
    act(() => setAccent("orange"));
    act(() => resetSettings());
    expect(read().current.accent).toBe(SETTINGS_DEFAULTS.accent);
  });
});

describe("typeface setter", () => {
  it("stores a chosen typeface", () => {
    act(() => setTypeface("geist"));
    expect(read().current.typeface).toBe("geist");
  });

  it("resets to the default typeface", () => {
    act(() => setTypeface("grotesk"));
    act(() => resetSettings());
    expect(read().current.typeface).toBe(SETTINGS_DEFAULTS.typeface);
  });
});

describe("hydrateSettings", () => {
  // The deploy-skew case: web knows a setting the api does not, so `settings.get`
  // returns it missing. Adopting the DEFAULT there would undo the user's choice
  // on the very next poll.
  it("keeps the current value for a field the server omits", () => {
    act(() => setAccent("orange"));
    act(() => hydrateSettings({ showMinimap: false }));
    expect(read().current.accent).toBe("orange");
    expect(read().current.showMinimap).toBe(false);
  });

  it("still adopts a value the server does send", () => {
    act(() => setAccent("orange"));
    act(() => hydrateSettings({ accent: "white" }));
    expect(read().current.accent).toBe("white");
  });
});
