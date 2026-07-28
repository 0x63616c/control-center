import { getLogger } from "@www/logger";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";

import {
  ACCENTS,
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  DIM_MAX,
  DIM_MIN,
  SETTINGS_DEFAULTS,
  SNAP_MODES,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
  TYPEFACES,
} from "../contract/settings";
import type * as schema from "../db/schema";
import { SETTINGS_SINGLETON_ID, settings } from "../db/schema";

// ─── shape + validation ────────────────────────────────────────────────────────

// The global wall-panel settings blob. This is the byte-for-byte contract the web
// client reads/writes; field names and types MUST NOT drift. Stored as a single
// jsonb `value` on the settings singleton row (services own the shape, not the DB).
//
// The vocabulary and bounds below come from ../contract/settings, which the web
// client imports too (via @cc/api/settings) , that shared module is what makes
// the "MUST NOT drift" rule above enforceable rather than aspirational. Only the
// FIELD LIST is still stated twice (this zod object vs web's Settings interface).

export const settingsSchema = z.object({
  /** Active (awake) backlight the panel drives itself, overriding the OS
   *  brightness. 0.01..1 (1% .. 100%). Idle drops from here to idleDimLevel. */
  activeBrightness: z.number().min(BRIGHTNESS_MIN).max(BRIGHTNESS_MAX),
  idleDimEnabled: z.boolean(),
  idleDimTimeoutMs: z.number().min(TIMEOUT_MIN_MS).max(TIMEOUT_MAX_MS),
  idleDimLevel: z.number().min(DIM_MIN).max(DIM_MAX),
  showFps: z.boolean(),
  showBuildBadge: z.boolean(),
  showBuildNumber: z.boolean(),
  snapMode: z.enum(SNAP_MODES),
  showMinimap: z.boolean(),
  // The synced soft-lock PIN. NOT auth , the API only enforces the 6-digit shape
  // and never validates or logs the value.
  pinCode: z.string().regex(/^\d{6}$/),
  // Randomize the PIN pad's digit positions on every prompt, so finger grease on
  // the panel glass stops advertising which four digits the PIN uses (#287).
  scramblePin: z.boolean(),
  // The board's highlight colour. Only the KEY is contract , the hex ramp each
  // key maps to is web's business (lib/accent.ts).
  accent: z.enum(ACCENTS),
  // The board's type pair (sans + its mono). Only the KEY is contract , the
  // families, weights and tracking each key maps to are web's business
  // (styles/tokens.css + lib/typeface.ts).
  typeface: z.enum(TYPEFACES),
});

/** A partial patch: any subset of the full settings object. */
export const settingsPatchSchema = settingsSchema.partial();

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Baseline settings returned when no row exists yet, and the merge floor for
 *  every read/write so a newly-added field falls back to its default. Shared with
 *  the web store, which layers its device-local fields on top. */
export const DEFAULTS: Settings = SETTINGS_DEFAULTS;

type Database = NodePgDatabase<typeof schema>;

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Read the global settings singleton. Returns DEFAULTS when the row is absent
 * (or the DB is unreadable). When present, the stored value is merged OVER
 * DEFAULTS (so a field added after the row was written falls back to its default)
 * and re-validated through settingsSchema.
 */
export async function getSettings(db: Database): Promise<Settings> {
  try {
    const rows = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.id, SETTINGS_SINGLETON_ID))
      .limit(1);
    const stored = rows[0]?.value;
    if (!stored) return DEFAULTS;
    return settingsSchema.parse({ ...DEFAULTS, ...stored });
  } catch (err) {
    getLogger().warn({ err }, "getSettings: read failed, returning defaults");
    return DEFAULTS;
  }
}

/**
 * Apply a partial patch to the global settings singleton and return the new full
 * Settings. Reads current (or DEFAULTS), merges the patch, validates, then upserts
 * the whole blob via insert().onConflictDoUpdate on the singleton id.
 */
export async function updateSettings(db: Database, patch: SettingsPatch): Promise<Settings> {
  const current = await getSettings(db);
  const next = settingsSchema.parse({ ...current, ...patch });
  const now = new Date();
  await db
    .insert(settings)
    .values({ id: SETTINGS_SINGLETON_ID, value: next, updatedAtUtc: now })
    .onConflictDoUpdate({
      target: settings.id,
      set: { value: next, updatedAtUtc: now },
    });
  getLogger().info({ patch }, "updateSettings: settings persisted");
  return next;
}
