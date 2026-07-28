import type { HaEntity } from "@www/core";
import { createHomeAssistantClient } from "@www/core";
import { config } from "./config";
import { findPlace } from "./places";

// Module-level singleton built from this feature's config (replaces apps/api's
// env-aware `ha` singleton , each caller builds its own instance from its
// config slice, per the UniFi/HA hoist precedent).
const ha = createHomeAssistantClient({ baseUrl: config.HA_URL, token: config.HA_TOKEN });

export interface TeslaData {
  name: string;
  nick: string;
  locked: boolean;
  place: string;
  lat: number | null;
  lon: number | null;
  charging: boolean;
  /**
   * Raw `sensor.<prefix>_charging` enum state, surfaced verbatim for the detail
   * modals (which distinguish stopped/complete/disconnected, not just the
   * boolean `charging`). Empty string when the entity is absent/dead.
   */
  chargingState: string;
  /**
   * True when the cabin HVAC is actively heating/cooling (preconditioning),
   * derived from the `climate.<prefix>_climate` entity , anything other than
   * "off" (and not a dead state) counts as on. False when the climate entity
   * is absent/dead.
   */
  preconditioning: boolean;
  rate: number;
  pct: number;
  range: number;
  odo: string;
  climate: number;
}

/**
 * Resolve the exact HA entity ids for the car. The Tesla Fleet integration names
 * every entity `<prefix>_*` (prefix is the car nickname, "evee"). Overridable
 * via TESLA_ENTITY_PREFIX. Verified against live HA, #304: the old
 * `_hvac_climate_system` / `_charger` ids are tesla_custom names and 404 here.
 */
function teslaEntityIds(prefix = config.TESLA_ENTITY_PREFIX) {
  return {
    battery: `sensor.${prefix}_battery_level`,
    charging: `sensor.${prefix}_charging`,
    rate: `sensor.${prefix}_charge_rate`,
    range: `sensor.${prefix}_battery_range`,
    odometer: `sensor.${prefix}_odometer`,
    cabin: `sensor.${prefix}_inside_temperature`,
    lock: `lock.${prefix}_lock`,
    tracker: `device_tracker.${prefix}_location`,
    // The integration exposes the cabin HVAC as a climate entity; its hvac state
    // (heat/cool/heat_cool vs off) tells us whether the car is preconditioning.
    hvac: `climate.${prefix}_climate`,
    // The charge switch , toggled to start/stop a charge session.
    chargeSwitch: `switch.${prefix}_charge`,
  };
}

export const ChargeState = {
  Starting: "starting",
  Charging: "charging",
  Stopped: "stopped",
  Complete: "complete",
  Disconnected: "disconnected",
  NoPower: "no_power",
} as const;
export type ChargeState = (typeof ChargeState)[keyof typeof ChargeState];

export const LockState = {
  Locked: "locked",
  Unlocked: "unlocked",
} as const;
export type LockState = (typeof LockState)[keyof typeof LockState];

const DeadState = {
  Unavailable: "unavailable",
  Unknown: "unknown",
  None: "none",
  Empty: "",
} as const;

/** HA states that mean "no usable value" , car asleep or entity disabled. */
const DEAD_STATES = new Set<string>(Object.values(DeadState));

function num(e: HaEntity | undefined, fallback: number): number {
  if (!e || DEAD_STATES.has(e.state)) return fallback;
  const n = Number(e.state);
  return Number.isFinite(n) ? n : fallback;
}

function titleCase(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Resolve the map-pill place name (www-6gx): a curated named place wins when the
 * car's GPS is within its radius, otherwise the HA zone name title-cased. No
 * coords AND no zone → unknown location, return "" (no fabricated label).
 */
function resolvePlace(lat: number | null, lon: number | null, zoneState?: string): string {
  if (lat !== null && lon !== null) {
    const match = findPlace(lat, lon);
    if (match) return match.name;
  }
  return zoneState ? titleCase(zoneState) : "";
}

export async function getTeslaData(): Promise<TeslaData> {
  if (!ha.isConfigured()) throw new Error("Home Assistant is not configured");

  const ids = teslaEntityIds();
  const keys = Object.keys(ids) as (keyof typeof ids)[];
  const results = await Promise.allSettled(keys.map((k) => ha.getEntity(ids[k])));
  const map: Record<string, HaEntity> = {};
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) map[keys[i]] = r.value;
  });

  // If we couldn't read even the battery, treat the whole car as unavailable.
  if (!map.battery || DEAD_STATES.has(map.battery.state)) {
    throw new Error("Tesla battery entity unavailable");
  }

  const pct = Math.round(num(map.battery, 0));
  // `sensor.<car>_charging` is an enum: starting | charging | stopped | complete | disconnected | no_power
  const chargeState = map.charging?.state ?? "";
  const chargingState = DEAD_STATES.has(chargeState) ? "" : chargeState;
  const charging = chargeState === ChargeState.Charging || chargeState === ChargeState.Starting;
  const rate = num(map.rate, 0);
  const range = Math.round(num(map.range, 0));
  const climate = Math.round(num(map.cabin, 0));

  // Odometer is often disabled in the integration, or reads unknown/unavailable
  // while the car sleeps , honest absence is ",", not a fabricated number.
  const odo =
    map.odometer && !DEAD_STATES.has(map.odometer.state)
      ? Math.round(num(map.odometer, 0)).toLocaleString("en-US")
      : ",";

  const locked = map.lock ? map.lock.state === LockState.Locked : false;

  // Preconditioning: the HVAC climate entity reports an hvac mode. Any active
  // mode (heat/cool/heat_cool/auto/fan_only) means the cabin is conditioning;
  // "off" or a dead state means it is not. No entity -> not preconditioning.
  const hvacState = map.hvac?.state ?? "";
  const preconditioning =
    hvacState.length > 0 && hvacState !== "off" && !DEAD_STATES.has(hvacState);

  const tracker = map.tracker;
  const latAttr = tracker ? Number(tracker.attributes.latitude) : Number.NaN;
  const lonAttr = tracker ? Number(tracker.attributes.longitude) : Number.NaN;
  const lat = Number.isFinite(latAttr) ? latAttr : null;
  const lon = Number.isFinite(lonAttr) ? lonAttr : null;
  // Prefer a curated named place when the car's GPS is within its radius (www-6gx);
  // otherwise fall back to the raw HA zone name, title-cased. With no tracker and
  // no coords the location is genuinely unknown , show nothing rather than invent one.
  const place = resolvePlace(lat, lon, tracker?.state);

  return {
    name: "Model Y",
    nick: "Evee",
    locked,
    place,
    lat,
    lon,
    charging,
    chargingState,
    preconditioning,
    rate,
    pct,
    range,
    odo,
    climate,
  };
}

/** Lock or unlock the car via the real `lock.<prefix>_lock` entity. */
export async function setTeslaLock(locked: boolean): Promise<void> {
  if (!ha.isConfigured()) throw new Error("Home Assistant is not configured");
  const ids = teslaEntityIds();
  await ha.callService("lock", locked ? "lock" : "unlock", { entity_id: ids.lock });
}

/** Start or stop a charge session via the `switch.<prefix>_charge` entity. */
export async function setTeslaCharging(on: boolean): Promise<void> {
  if (!ha.isConfigured()) throw new Error("Home Assistant is not configured");
  const ids = teslaEntityIds();
  await ha.callService("switch", on ? "turn_on" : "turn_off", { entity_id: ids.chargeSwitch });
}

/**
 * Toggle cabin preconditioning via the HVAC climate entity. `on` turns the
 * climate system on (auto hvac mode); off shuts it down.
 */
export async function setTeslaPreconditioning(on: boolean): Promise<void> {
  if (!ha.isConfigured()) throw new Error("Home Assistant is not configured");
  const ids = teslaEntityIds();
  if (on) {
    await ha.callService("climate", "turn_on", { entity_id: ids.hvac });
  } else {
    await ha.callService("climate", "turn_off", { entity_id: ids.hvac });
  }
}
