/**
 * The PER-DEVICE settings CONTRACT , the vocabulary and bounds for preferences
 * that belong to one physical panel rather than the installation as a whole.
 *
 * Sibling of ./settings.ts, and bound by the same rule: ZERO imports, plain
 * literals only. It is re-exported through `packages/api`
 * (`@cc/api/device-settings`) and therefore lands in the browser bundle.
 *
 * Why a separate store rather than more fields on the settings singleton: the
 * settings row is global (id = "singleton") and every panel reads the same one.
 * Volume cannot work that way , it is a property of a specific piece of hardware
 * in a specific room, and two panels at the same level would be a coincidence,
 * not a preference. `pushEnabled` hit the same wall earlier and was solved by
 * keeping it device-local in the web store; that works but is invisible to the
 * server and lost on reinstall. Keying on `device_id` fixes both.
 */

// ─── bounds ───────────────────────────────────────────────────────────────────

/** Output volume as a 0..1 fraction of the device's media volume.
 *
 *  Unlike brightness (floor 0.01, because a black panel looks broken), volume
 *  reaches a true 0 , that IS the mute control, which is why there is no
 *  separate mute toggle. A silent panel is a legitimate resting state. */
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 1;

/** Longest device name accepted server-side. The client truncates to this
 *  bound before pushing (see lib/device-name.ts), this is the enforcement
 *  point that truncation exists to avoid hitting. */
export const NAME_MAX_LENGTH = 60;

// ─── defaults ─────────────────────────────────────────────────────────────────

/** Every per-device setting and its default , the baseline returned when a panel
 *  has no row yet, and the merge floor on every read/write so a field added after
 *  a row was written falls back sanely.
 *
 *  Half volume rather than full: the panel is a wall fixture in a shared room and
 *  a first boot at 100% is startling. The slider is the remedy either way. */
export const DEVICE_SETTINGS_DEFAULTS = {
  volume: 0.5,
} as const satisfies Record<string, unknown>;
