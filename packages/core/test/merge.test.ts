import { describe, expect, it } from "vitest";

import { mergeDeviceState, sanitizeClimateDesired } from "../src/device-state/merge";

// www-dnpj: desired must only ever carry the commandable climate fields. A desired
// that includes the reported-only ambient/action shadows the live reported values
// in the merge overlay and freezes the panel's room temp at seed time.
describe("sanitizeClimateDesired", () => {
  it("strips reported-only ambient/action, keeping the commandable fields", () => {
    expect(
      sanitizeClimateDesired({
        mode: "cool",
        target: 72,
        fanMode: "on",
        ambient: 71,
        action: "cooling",
      }),
    ).toEqual({ mode: "cool", target: 72, fanMode: "on" });
  });

  it("preserves a heat_cool range and omits absent optionals", () => {
    expect(
      sanitizeClimateDesired({ mode: "heat_cool", targetLow: 68, targetHigh: 76, ambient: 70 }),
    ).toEqual({ mode: "heat_cool", targetLow: 68, targetHigh: 76 });
  });
});

// ─── mergeDeviceState (light) ────────────────────────────────────────────────
// Desired-authoritative (www-7d5b.2.4): desired is the effective state when
// present; pending means HA has not yet converged with it.
describe("mergeDeviceState (light)", () => {
  it("returns desiredState with pending=true while reported has not converged", () => {
    const result = mergeDeviceState({
      reportedState: { on: false },
      desiredState: { on: true },
      available: true,
    });
    expect(result).toEqual({ state: { on: true }, pending: true, available: true });
  });

  it("returns desiredState with pending=false once reported converges (within tolerance)", () => {
    const result = mergeDeviceState({
      reportedState: { on: true, brightness: 200, color: { rgb: [0, 2, 254] } },
      desiredState: { on: true, brightness: 200, color: { rgb: [0, 0, 255] } },
      available: true,
    });
    expect(result.state).toEqual({ on: true, brightness: 200, color: { rgb: [0, 0, 255] } });
    expect(result.pending).toBe(false);
  });

  it("returns reportedState with pending=false when desired is null", () => {
    const result = mergeDeviceState({
      reportedState: { on: false },
      desiredState: null,
      available: true,
    });
    expect(result).toEqual({ state: { on: false }, pending: false, available: true });
  });

  it("clears pending when native xy color converges within HA rounding", () => {
    const result = mergeDeviceState({
      reportedState: { on: true, color: { xy: [0.7, 0.3] } },
      desiredState: { on: true, color: { xy: [0.701, 0.299] } },
      available: true,
    });
    expect(result.pending).toBe(false);
  });

  it("overlays a bare {on} desired onto reported brightness/color (no zeroing, not pending)", () => {
    // www-7d5b.2.4 regression: a bare on/off toggle writes only { on } and must
    // NOT zero out brightness/color, nor sit perpetually pending.
    const result = mergeDeviceState({
      reportedState: { on: true, brightness: 200, color: { rgb: [255, 0, 0] } },
      desiredState: { on: true },
      available: true,
    });
    expect(result.state).toEqual({ on: true, brightness: 200, color: { rgb: [255, 0, 0] } });
    expect(result.pending).toBe(false);
  });

  it("a specified desired field overrides reported and drives pending", () => {
    const result = mergeDeviceState({
      reportedState: { on: true, brightness: 200, color: { rgb: [255, 0, 0] } },
      desiredState: { on: true, color: { rgb: [0, 0, 255] } },
      available: true,
    });
    expect(result.state).toEqual({ on: true, brightness: 200, color: { rgb: [0, 0, 255] } });
    expect(result.pending).toBe(true);
  });
});

describe("mergeDeviceState (climate)", () => {
  it("surfaces LIVE reported ambient/action even when a stale desired carries them (www-dnpj)", () => {
    const merged = mergeDeviceState({
      desiredState: { mode: "cool", target: 72, ambient: 71, action: "idle" },
      reportedState: { mode: "cool", target: 72, ambient: 73, action: "cooling" },
      available: true,
    });
    expect(merged.state).toMatchObject({
      mode: "cool",
      target: 72,
      ambient: 73,
      action: "cooling",
    });
  });
});
