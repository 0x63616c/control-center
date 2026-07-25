import { getLogger } from "@www/logger";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";

import {
  DEVICE_SETTINGS_DEFAULTS,
  NAME_MAX_LENGTH,
  VOLUME_MAX,
  VOLUME_MIN,
} from "../contract/device-settings";
import type * as schema from "../db/schema";
import { deviceSettings } from "../db/schema";

// ─── shape + validation ────────────────────────────────────────────────────────

// Per-panel settings, stored as a single jsonb `value` on a row keyed by the
// client's device_id. Same contract rule as the global settings blob: field
// names and types MUST NOT drift, and the vocabulary/bounds come from
// ../contract/device-settings, which the web client imports too (via
// @cc/api/device-settings).

export const deviceSettingsSchema = z.object({
  /** Output volume as a 0..1 fraction of the device's media volume. 0 is a
   *  legitimate value , it is the mute control. */
  volume: z.number().min(VOLUME_MIN).max(VOLUME_MAX),
  /** Human-readable device name (ticket #63): persisted server-side so it
   *  survives reinstall and is visible off-device, not just a local nag. Empty
   *  string means "not yet set", mirroring lib/device-name.ts's local model. */
  name: z.string().trim().max(NAME_MAX_LENGTH).default(""),
});

/** A partial patch: any subset of the full per-device settings object. */
export const deviceSettingsPatchSchema = deviceSettingsSchema.partial();

export type DeviceSettings = z.infer<typeof deviceSettingsSchema>;
export type DeviceSettingsPatch = z.infer<typeof deviceSettingsPatchSchema>;

/** Baseline returned for a panel with no row yet, and the merge floor for every
 *  read/write so a newly-added field falls back to its default.
 *
 *  Spreads the wire contract's DEVICE_SETTINGS_DEFAULTS (volume-only , that
 *  constant is a zero-import literal shared with the web client's generic
 *  DeviceSettings interface, which stays volume-only) and adds `name` locally,
 *  since the empty-string default is service-only bookkeeping, not part of the
 *  cross-boundary contract. */
export const DEFAULTS: DeviceSettings = { ...DEVICE_SETTINGS_DEFAULTS, name: "" };

/** Device ids are minted client-side (lib/device-id.ts) and are the primary key,
 *  so they are bounded here rather than trusted , an empty or absurd id would
 *  otherwise create junk rows. */
export const deviceIdSchema = z.string().min(1).max(128);

type Database = NodePgDatabase<typeof schema>;

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Read one panel's settings. Returns DEFAULTS when the row is absent (the normal
 * case for a panel that has never changed anything) or the DB is unreadable.
 * When present, the stored value is merged OVER DEFAULTS so a field added after
 * the row was written falls back to its default, then re-validated.
 */
export async function getDeviceSettings(db: Database, deviceId: string): Promise<DeviceSettings> {
  try {
    const rows = await db
      .select({ value: deviceSettings.value })
      .from(deviceSettings)
      .where(eq(deviceSettings.deviceId, deviceId))
      .limit(1);
    const stored = rows[0]?.value;
    if (!stored) return DEFAULTS;
    return deviceSettingsSchema.parse({ ...DEFAULTS, ...stored });
  } catch (err) {
    getLogger().warn({ err, deviceId }, "getDeviceSettings: read failed, returning defaults");
    return DEFAULTS;
  }
}

/**
 * Apply a partial patch to one panel's settings and return the new full object.
 * Reads current (or DEFAULTS), merges, validates, then upserts the whole blob on
 * the device_id key , so a panel's first write creates its row and no
 * registration step is needed.
 */
export async function updateDeviceSettings(
  db: Database,
  deviceId: string,
  patch: DeviceSettingsPatch,
): Promise<DeviceSettings> {
  const current = await getDeviceSettings(db, deviceId);
  const next = deviceSettingsSchema.parse({ ...current, ...patch });
  const now = new Date();
  await db
    .insert(deviceSettings)
    .values({ deviceId, value: next, updatedAtUtc: now })
    .onConflictDoUpdate({
      target: deviceSettings.deviceId,
      set: { value: next, updatedAtUtc: now },
    });
  getLogger().info({ deviceId, patch }, "updateDeviceSettings: device settings persisted");
  return next;
}
