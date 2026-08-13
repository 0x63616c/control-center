import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// Device sync: backend owns device state; frontend reads merged (effective) state.
// Ported from evee device-state-sync pattern. Desired window is 5s for CC.

/**
 * Color of a light: RGB, native CIE XY, or a white color temperature in Kelvin
 * (mutually exclusive in practice; HA reports whichever color mode is active).
 * Carried in desired/reported state so the DB-authoritative enforcer can drive
 * and detect color drift, not just on/off + brightness (www-7d5b.2.2).
 */
export interface LightColor {
  rgb?: [number, number, number];
  xy?: [number, number];
  kelvin?: number;
}

export interface DeviceLightState {
  on: boolean;
  brightness?: number;
  color?: LightColor;
  /** Home Assistant fade duration. Kept with desired state so retries preserve the scene transition. */
  transitionSeconds?: number;
}

/**
 * Climate (thermostat) state carried in a device_state row (www-unxz.2). Only the
 * fields the dashboard COMMANDS live in DESIRED: hvac mode, the single setpoint
 * (cool/heat) or the heat_cool range, and the AC fan_mode. Ambient temperature
 * and the live hvac_action are REPORTED-ONLY (never desired) and always come from
 * real HA values, the enforcer writes them into reportedState each cycle, never
 * an invented number (repo zero-fake-data rule). `target` and `targetLow/High` are
 * mutually exclusive in practice (single vs range mode), mirroring ClimateState.
 */
export interface DeviceClimateState {
  mode: string;
  target?: number;
  targetLow?: number;
  targetHigh?: number;
  fanMode?: string;
  /** Reported-only: real ambient temperature from HA (current_temperature). */
  ambient?: number;
  /** Reported-only: real hvac_action from HA (cooling/heating/idle). */
  action?: string;
}

/**
 * Sonos speaker state carried in a device_state row (www-5mek). Volume is the
 * single commandable dimension: the dashboard writes DESIRED instantly and the
 * sonos-volume-enforcer reconciles it onto the player over UPnP, adopting
 * external changes (Sonos app, hardware buttons) outside the command window ,
 * the same DB-authoritative model as lights.
 */
export interface DeviceSpeakerState {
  volume: number;
}

export type DeviceStateValue = DeviceLightState | DeviceClimateState | DeviceSpeakerState;

// The pg-contract test derives its CREATE TABLE DDL from this table object via
// `../../test/schema-ddl.ts`, so it stays in sync automatically when this table
// changes.
export const deviceState = pgTable(
  "device_state",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    entityId: text("entity_id").notNull(),
    domain: text("domain").notNull(),
    label: text("label").notNull(),
    reportedState: jsonb("reported_state").$type<DeviceStateValue | null>(),
    reportedAtUtc: timestamp("reported_at_utc", { withTimezone: true }),
    reportedChangedAtUtc: timestamp("reported_changed_at_utc", { withTimezone: true }),
    desiredState: jsonb("desired_state").$type<DeviceStateValue | null>(),
    desiredAtUtc: timestamp("desired_at_utc", { withTimezone: true }),
    desiredUntilUtc: timestamp("desired_until_utc", { withTimezone: true }),
    available: boolean("available").notNull().default(false),
    createdAtUtc: timestamp("created_at_utc", { withTimezone: true }).notNull().defaultNow(),
    updatedAtUtc: timestamp("updated_at_utc", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("device_state_entity_id_idx").on(t.entityId),
    index("device_state_kind_idx").on(t.kind),
  ],
);

export const DeviceKind = {
  Light: "light",
  Switch: "switch",
  Climate: "climate",
  // Sonos players (www-5mek) , owned by the sonos-volume-enforcer, never HA-mapped.
  Speaker: "speaker",
} as const;
export type DeviceKind = (typeof DeviceKind)[keyof typeof DeviceKind];
