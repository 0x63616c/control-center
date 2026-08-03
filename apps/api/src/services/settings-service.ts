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
  GOAL_DAY_CUTOFF_MAX_HOUR,
  GOAL_DAY_CUTOFF_MIN_HOUR,
  LOCK_SCREEN_BLUR_MAX_PERCENT,
  LOCK_SCREEN_BLUR_MIN_PERCENT,
  PIN_PAD_LAYOUTS,
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
  lockScreenEnabled: z.boolean(),
  lockScreenBlurPercent: z
    .number()
    .int()
    .min(LOCK_SCREEN_BLUR_MIN_PERCENT)
    .max(LOCK_SCREEN_BLUR_MAX_PERCENT),
  showFps: z.boolean(),
  showBuildBadge: z.boolean(),
  showBuildNumber: z.boolean(),
  snapMode: z.enum(SNAP_MODES),
  showMinimap: z.boolean(),
  // The synced soft-lock PIN. NOT auth , the API only enforces the 6-digit shape
  // and never validates or logs the value.
  pinCode: z.string().regex(/^\d{6}$/),
  // How the PIN pad arranges its digits, so finger grease on the panel glass
  // stops advertising which four digits the PIN uses (#287, #291). See
  // PIN_PAD_LAYOUTS for what each key means and what it costs.
  pinPadLayout: z.enum(PIN_PAD_LAYOUTS),
  // The board's highlight colour. Only the KEY is contract , the hex ramp each
  // key maps to is web's business (lib/accent.ts).
  accent: z.enum(ACCENTS),
  // The board's type pair (sans + its mono). Only the KEY is contract , the
  // families, weights and tracking each key maps to are web's business
  // (styles/tokens.css + lib/typeface.ts).
  typeface: z.enum(TYPEFACES),
  // An IANA name, not a browser/host offset. An offset changes with DST and
  // cannot correctly identify a calendar day across a future transition.
  timeZone: z.string().refine(
    (value) => {
      try {
        new Intl.DateTimeFormat(undefined, { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { message: "must be a recognised IANA time zone" },
  ),
  goalDayCutoffHour: z.number().int().min(GOAL_DAY_CUTOFF_MIN_HOUR).max(GOAL_DAY_CUTOFF_MAX_HOUR),
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

/**
 * Carry a stored blob's retired fields onto their replacements before validation
 * strips them.
 *
 * `scramblePin` (a boolean, shipped in #287) became the three-way
 * `pinPadLayout` in #291, because "rotated" , ascending order with a random
 * starting digit , is a third option a boolean cannot express. Without this
 * mapping a panel that had deliberately turned scrambling OFF would silently get
 * the default (`scrambled`) back on the next read, since zod drops the key it no
 * longer knows and the DEFAULTS merge fills the gap.
 *
 * The blob is jsonb, so `stored` is genuinely unknown-shaped here; the guards
 * are load-bearing rather than ceremony.
 */
function migrateLegacy(stored: unknown): Record<string, unknown> {
  if (typeof stored !== "object" || stored === null) return {};
  const blob = { ...(stored as Record<string, unknown>) };
  if (blob.pinPadLayout === undefined && typeof blob.scramblePin === "boolean") {
    blob.pinPadLayout = blob.scramblePin ? "scrambled" : "fixed";
  }
  return blob;
}

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
    return settingsSchema.parse({ ...DEFAULTS, ...migrateLegacy(stored) });
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
