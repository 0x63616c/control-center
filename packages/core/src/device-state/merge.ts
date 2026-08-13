import { lightColorConverged } from "./color";
import type {
  DeviceClimateState,
  DeviceLightState,
  DeviceSpeakerState,
  DeviceStateValue,
} from "./schema";
import type { MergedDeviceState } from "./store";

/**
 * Narrow a DeviceStateValue to a light state. The union now also holds
 * DeviceClimateState (www-unxz.2); a light state has the boolean `on` field, which
 * a climate state never does , so this is the discriminant.
 */
export function isLightState(v: DeviceStateValue | null | undefined): v is DeviceLightState {
  return v != null && typeof (v as DeviceLightState).on === "boolean";
}

/** Narrow a DeviceStateValue to a climate state (has `mode`, never `on`). */
export function isClimateState(v: DeviceStateValue | null | undefined): v is DeviceClimateState {
  return (
    v != null &&
    typeof (v as DeviceClimateState).mode === "string" &&
    typeof (v as DeviceLightState).on !== "boolean"
  );
}

/** Narrow a DeviceStateValue to a speaker state (has numeric `volume`, never `on`/`mode`). */
export function isSpeakerState(v: DeviceStateValue | null | undefined): v is DeviceSpeakerState {
  return (
    v != null &&
    typeof (v as DeviceSpeakerState).volume === "number" &&
    typeof (v as DeviceLightState).on !== "boolean" &&
    typeof (v as DeviceClimateState).mode !== "string"
  );
}

// The one hvac mode this module reasons about. Declared locally (not imported
// from climate-service, which imports this module) to keep the dependency
// one-way; `DeviceClimateState.mode` is a raw HA string.
const HvacModeValue = { Off: "off" } as const;

/**
 * Strip a climate desired down to the COMMANDABLE fields (mode/setpoints/fan).
 * Desired must never carry the reported-only ambient/action: the merge overlay
 * is desired-over-reported, so a desired holding a seed-time ambient shadows the
 * live reported room temp forever (www-dnpj , the panel froze at the seed-time
 * temperature). Used at enforcer seed, on every desired write, and as the merge
 * overlay so pre-fix rows render correctly even before they self-heal.
 */
export function sanitizeClimateDesired(state: DeviceClimateState): DeviceClimateState {
  const clean: DeviceClimateState = { mode: state.mode };
  if (state.target != null) clean.target = state.target;
  if (state.targetLow != null) clean.targetLow = state.targetLow;
  if (state.targetHigh != null) clean.targetHigh = state.targetHigh;
  if (state.fanMode != null) clean.fanMode = state.fanMode;
  return clean;
}

/**
 * True when HA's reported state can carry setpoints at all. An OFF thermostat
 * reports none (ecobee drops `temperature` / `target_temp_low|high` entirely),
 * so while off the setpoint dimension is unobservable: there is nothing to
 * converge against and nothing to actuate.
 */
export function climateSetpointsObservable(state: DeviceClimateState): boolean {
  return state.mode !== HvacModeValue.Off;
}

/**
 * Drift convergence for climate desired-vs-reported (www-unxz.2). Only the
 * COMMANDABLE fields count: mode must match exactly; a SPECIFIED desired setpoint
 * (target / targetLow / targetHigh) must match exactly; fanMode must match when
 * desired specifies it. Reported-only ambient/action are ignored (they can never
 * "drift" from a desired we don't carry). A desired field left unset means "no
 * intent for it", so it can't diverge , same partial-overlay rule as lights.
 */
export function climateStateConverged(
  desired: DeviceClimateState,
  reported: DeviceClimateState,
  opts: { ignoreFan?: boolean } = {},
): boolean {
  if (desired.mode !== reported.mode) return false;
  // A thermostat that is OFF reports no setpoint attributes at all, so the
  // setpoint dimension is neither observable nor commandable there. A remembered
  // setpoint (see rememberedClimateDesired) must not read as eternal drift.
  if (climateSetpointsObservable(reported)) {
    if (desired.target != null && desired.target !== reported.target) return false;
    if (desired.targetLow != null && desired.targetLow !== reported.targetLow) return false;
    if (desired.targetHigh != null && desired.targetHigh !== reported.targetHigh) return false;
  }
  // While the AC is actively conditioning it owns the blower (ignoreFan); a fan
  // mismatch then is the AC asserting the fan, not drift to fight (www-pu4m).
  if (!opts.ignoreFan && desired.fanMode != null && desired.fanMode !== reported.fanMode) {
    return false;
  }
  return true;
}

// Tolerances for desired-vs-reported convergence (pending detection). HA does not
// round-trip color/brightness exactly, so a small slack stops a freshly-actuated
// light from reading as perpetually "pending".
const BRIGHTNESS_TOLERANCE = 3;

/**
 * Tolerant convergence of the desired fields that are SPECIFIED vs reported.
 * Desired is a PARTIAL overlay: only the fields it actually carries are intent,
 * so a desired that omits brightness/color (e.g. a bare on/off toggle) must NOT
 * count as diverged just because reported has a color. `on` is always specified;
 * brightness/color are compared only when desired specifies them.
 */
function converged(desired: DeviceStateValue, reported: DeviceStateValue): boolean {
  // Climate uses its own commandable-field convergence (www-unxz.2).
  if (isClimateState(desired) || isClimateState(reported)) {
    if (!isClimateState(desired) || !isClimateState(reported)) return false;
    return climateStateConverged(desired, reported);
  }
  if (!isLightState(desired) || !isLightState(reported)) return false;
  if (desired.on !== reported.on) return false;
  if (!desired.on) return true;
  if (
    desired.brightness != null &&
    reported.brightness != null &&
    Math.abs(desired.brightness - reported.brightness) > BRIGHTNESS_TOLERANCE
  ) {
    return false;
  }
  // Only a SPECIFIED desired color can diverge; an absent desired color means
  // "no color intent" → reflect reported, never perpetually pending.
  if (desired.color != null && !lightColorConverged(desired.color, reported.color)) {
    return false;
  }
  return true;
}

/**
 * Merge reported and desired into the effective state. Desired is the source of
 * truth, but it is a PARTIAL OVERLAY: each field desired specifies wins (the
 * enforcer drives HA to it); fields desired omits fall back to reported. So a
 * bare on/off toggle (`{on}`) still shows the real brightness/color from HA
 * instead of zeros, and `activeScene` derives from the effective color. This
 * matches the enforcer, which only actuates the fields desired specifies
 * (www-7d5b.2.4). `pending` is true only while a SPECIFIED desired field has not
 * yet converged with reported. The old 5s desiredUntilUtc window is retired.
 */
export function mergeDeviceState(device: {
  reportedState?: DeviceStateValue | null;
  desiredState?: DeviceStateValue | null;
  available: boolean;
}): MergedDeviceState {
  const desired = device.desiredState ?? null;
  const reported = device.reportedState ?? null;
  if (desired != null) {
    // Per-field overlay: reported as base, desired's specified fields override.
    // Climate desired is sanitized first so a stale pre-fix desired carrying the
    // reported-only ambient/action can never shadow the live values (www-dnpj).
    const overlay = isClimateState(desired) ? sanitizeClimateDesired(desired) : desired;
    const state = reported != null ? { ...reported, ...overlay } : desired;
    const pending = reported == null ? true : !converged(desired, reported);
    return { state, pending, available: device.available };
  }
  return { state: reported, pending: false, available: device.available };
}
