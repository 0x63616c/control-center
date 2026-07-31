// Drizzle schema. Backend agents add tables here.
import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// The `job` durable queue table now lives in @www/core
// (packages/core/src/jobs/schema.ts). Re-exported here (an identifier
// re-export that preserves object identity) so the drizzle relational schema
// still registers it and existing imports from "../db/schema" keep working
// unchanged (same precedent as deviceState/integrationSyncStatus below).
// Device sync: backend owns device state; frontend reads merged (effective) state.
// Ported from evee device-state-sync pattern. Desired window is 5s for CC.
// The deviceState table + its state types + DeviceKind now live in @www/core
// (packages/core/src/device-state/schema.ts); re-exported here so existing
// imports from "../db/schema" keep working unchanged.
// The integrationSyncStatus table now lives in @www/core
// (packages/core/src/integration-sync/schema.ts). Re-exported here (an identifier
// re-export that preserves object identity) so the drizzle relational schema still
// registers it and existing imports from "../db/schema" keep working unchanged.
export {
  type DeviceClimateState,
  DeviceKind,
  type DeviceLightState,
  type DeviceSpeakerState,
  type DeviceStateValue,
  deviceState,
  integrationSyncStatus,
  job,
  type LightColor,
} from "@www/core";

// The lamp_mode table (LAMP_MODE_SINGLETON_ID) now lives in features/ctrl/schema.ts
// (Track C fold) — imported by the hand-wired light-enforcer/party-service via
// @features/ctrl/schema.

// Global control-center settings, a SINGLETON row (id = SETTINGS_SINGLETON_ID).
// Holds the wall panel's durable preferences (idle-dim, dev overlays, snap mode)
// as a single JSON blob so new fields can be added without a column
// migration. The web client reads/writes the whole Settings object; the shape,
// defaults, and validation live in services/settings-service.ts. Modeled on the
// lamp_mode keyed-singleton pattern.
export const SETTINGS_SINGLETON_ID = "singleton";

// Kept as a structural type here so the jsonb column is typed; the authoritative
// Settings shape + Zod schema + defaults live in services/settings-service.ts.
export interface SettingsValue {
  idleDimEnabled: boolean;
  idleDimTimeoutMs: number;
  idleDimLevel: number;
  showFps: boolean;
  showBuildBadge: boolean;
  snapMode: "proximity" | "mandatory" | "mandatory-settle" | "none" | "spring";
}

export const settings = pgTable("settings", {
  id: text("id").primaryKey(),
  value: jsonb("value").$type<SettingsValue>().notNull(),
  updatedAtUtc: timestamp("updated_at_utc", { withTimezone: true }).notNull().defaultNow(),
});

// Per-device control-center settings, one row PER PANEL keyed on the web
// client's stable device_id (lib/device-id.ts , e.g. "ipad13-1-3f9a2c1b"). Same
// jsonb-blob approach as `settings` above so new fields need no column
// migration, but deliberately NOT that table: `settings` is a singleton every
// panel shares, and these are preferences that belong to one piece of hardware
// in one room. Volume is the first , two panels at the same level would be a
// coincidence, not a shared truth. Shape, defaults, and validation live in
// services/device-settings-service.ts; bounds in contract/device-settings.ts.
//
// device_id is the primary key and is minted client-side, so rows appear on
// first write from a panel and no registration step is needed.

// Kept as a structural type here so the jsonb column is typed; the authoritative
// shape + Zod schema + defaults live in services/device-settings-service.ts.
export interface DeviceSettingsValue {
  volume: number;
}

export const deviceSettings = pgTable("device_settings", {
  deviceId: text("device_id").primaryKey(),
  value: jsonb("value").$type<DeviceSettingsValue>().notNull(),
  updatedAtUtc: timestamp("updated_at_utc", { withTimezone: true }).notNull().defaultNow(),
});

// Latest known TestFlight build of the wall-panel iOS shell, a SINGLETON row
// (id = ASC_BUILD_STATUS_SINGLETON_ID). Written by the asc-version-poll worker
// (App Store Connect /v1/builds), read by the system.appUpdateStatus tRPC query
// so the board can raise an "update available" banner. One row is enough: build
// numbers are contiguous (fastlane latest_testflight_build_number + 1), so
// "builds behind" is latest - installed with no history needed. Modeled on the
// lamp_mode / settings keyed-singleton pattern.
export const ASC_BUILD_STATUS_SINGLETON_ID = "singleton";

export const ascBuildStatus = pgTable("asc_build_status", {
  id: text("id").primaryKey(),
  buildNumber: integer("build_number").notNull(),
  marketingVersion: text("marketing_version").notNull(),
  uploadedAtUtc: timestamp("uploaded_at_utc", { withTimezone: true }).notNull(),
  fetchedAtUtc: timestamp("fetched_at_utc", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Captive portal (www-q002) ──────────────────────────────────────────────
// The portal_rate_limit + portal_authorization tables + PORTAL_RATE_LIMIT_ID
// were FOLDED into the guest-wifi feature (Track C, C7): they now live in
// features/guest-wifi/schema.ts and reach drizzle-kit via the generated schema
// barrel (features/_generated/schema.gen.ts, which unions this file with every
// feature's schema.ts). Nothing in apps/api references them directly anymore.

// Wake photos (spec docs/specs/2026-07-18-interaction-logging-design.md) were
// FOLDED into the wakes feature (Track C, Wave 5): the `wake_photo` table now
// lives in features/wakes/schema.ts and reaches drizzle-kit via the generated
// schema barrel (features/_generated/schema.gen.ts).

// Photo booth (the wall panel's on-demand camera) was FOLDED into the booth
// feature (Track C, final tile): the `booth_photo` table now lives in
// features/booth/schema.ts and reaches drizzle-kit via the generated schema
// barrel (features/_generated/schema.gen.ts).

// ─── GitHub Actions deploy pipeline (www-github-deploy) ────────────────────
// githubRun, githubRunLogTail, githubPollStatus, GITHUB_POLL_STATUS_SINGLETON_ID
// were FOLDED into the deploys feature (Track C, Wave 2): they now live in
// features/deploys/schema.ts and reach drizzle-kit via the generated schema
// barrel (features/_generated/schema.gen.ts, which unions this file with every
// feature's schema.ts). The retention purge folded too (Track C shell-cleanup):
// features/deploys/jobs.ts now purges the physical github_run/github_run_log_tail
// tables via raw SQL from its Temporal purge activity (ADR-0008).

// notification + devicePushToken (Notification Center) were FOLDED into the
// notif feature (Track C, S1): they now live in features/notif/schema.ts and
// reach drizzle-kit via the generated schema barrel (unions this file with
// every feature's schema.ts), same precedent as the deploys fold above.
