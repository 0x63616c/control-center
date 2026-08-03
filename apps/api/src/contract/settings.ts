/**
 * The wall-panel settings CONTRACT , the single definition of the vocabulary and
 * bounds that both sides of the wire must agree on.
 *
 * This module has ZERO imports, deliberately. It is re-exported through
 * `packages/api` (`@cc/api/settings`) and therefore lands in the browser bundle,
 * so anything reachable from here ships to the panel. Keep it plain literals:
 * no zod, no drizzle, no logger. The api's settings-service builds its zod
 * schema from these values; the web store builds its clamps and its picker from
 * the same ones.
 *
 * It exists because settings-service's own header calls this blob "the
 * byte-for-byte contract the web client reads/writes; field names and types MUST
 * NOT drift" , and until now nothing enforced that. The snap-mode union was
 * declared three separate times, and the idle-timeout ceiling had already
 * drifted (web clamped to 10 min while the server accepted 60).
 */

// ─── snap-mode vocabulary ─────────────────────────────────────────────────────
// How the tile board settles when the user lets go of a drag. The board maps
// these to CSS scroll-snap (that mapping is a rendering concern and stays in
// Board.tsx); the human-facing labels are UI vocabulary and stay in web.
export const SNAP_MODES = ["proximity", "mandatory", "mandatory-settle", "none", "spring"] as const;
export type SnapMode = (typeof SNAP_MODES)[number];

// ─── accent vocabulary ────────────────────────────────────────────────────────
// The single highlight colour the panel is built around (every `--acc*` token
// derives from it). Only the KEY is wire contract; the hex ramp each key maps to
// is a rendering concern and lives in web's lib/accent.ts.
export const ACCENTS = ["blue", "white", "green", "orange"] as const;
export type Accent = (typeof ACCENTS)[number];

// ─── typeface vocabulary ──────────────────────────────────────────────────────
// The board's type pair. A key names a SANS AND ITS MONO together (the panel
// reads --mono for every stat value, log count, sha and timestamp, so the two
// always travel as one design decision), plus the weights and tracking that
// face needs. As with accents, only the KEY is wire contract; the families live
// in web's styles/tokens.css and the labels in web's lib/typeface.ts.
export const TYPEFACES = ["grotesk", "sf", "geist"] as const;
export type Typeface = (typeof TYPEFACES)[number];

// ─── PIN-pad layout vocabulary ────────────────────────────────────────────────
// How the PIN pad arranges its ten digits (#287, #291). Only the KEY is wire
// contract; what each one draws is web's business (components/pin/PinPad.tsx),
// as are the human labels.
//
//   fixed     , the familiar phone pad, every prompt. Fastest to type and the
//               only one that leaks the PIN's digit SET through finger grease.
//   rotated   , ascending order preserved, random starting digit each prompt.
//               Wear still spreads over all ten keys, but the pad stays scannable
//               (find one digit, the rest follow) instead of forcing ten lookups.
//               Weaker than `scrambled`: only 10 layouts exist, and a single
//               session's fresh smudges give the PIN up to a rotation.
//   scrambled , a fresh uniform permutation each prompt. Strongest against wear,
//               slowest to read.
//   scrambled-per-key , a fresh uniform permutation after EVERY digit entered
//               (#302). What this buys over `scrambled` is narrow, real, and NOT
//               what it looks like. Against an observer who sees only your hand,
//               `scrambled` already leaks nothing , the pad is a permutation
//               they do not know, so watched positions name no digits. The one
//               it beats is the observer who glimpses the SCREEN once , a camera
//               frame, a head turning at the wrong moment , and then watches the
//               hand: under `scrambled` that single glimpse fixes the mapping
//               for the whole entry and gives up the entire PIN, while here it
//               gives up one digit. Against an observer watching the screen
//               throughout, neither helps. Costs a full visual re-scan per digit
//               , six scans per unlock, not one.
export const PIN_PAD_LAYOUTS = ["fixed", "rotated", "scrambled", "scrambled-per-key"] as const;
export type PinPadLayout = (typeof PIN_PAD_LAYOUTS)[number];

// ─── bounds ───────────────────────────────────────────────────────────────────

/** Idle-dim timeout's valid window: 1 min .. 10 min. The ceiling matches what
 *  the settings slider has always offered , the server previously allowed an
 *  hour, but nothing could produce such a value. */
export const TIMEOUT_MIN_MS = 60_000;
export const TIMEOUT_MAX_MS = 600_000;

/** Dim target, as a 0..1 brightness fraction. Stays below full so "dimmed"
 *  always reads darker than "awake". */
export const DIM_MIN = 0.01;
export const DIM_MAX = 0.99;

/** Active (awake) backlight. Unlike the dim level, this reaches a full 100%. */
export const BRIGHTNESS_MIN = 0.01;
export const BRIGHTNESS_MAX = 1;

export const LOCK_SCREEN_BLUR_MIN_PERCENT = 0;
export const LOCK_SCREEN_BLUR_MAX_PERCENT = 100;

/** The panel's initial local calendar zone. The persisted setting may replace it. */
export const DEFAULT_TIME_ZONE = "America/Los_Angeles";

// ─── defaults ─────────────────────────────────────────────────────────────────

/** Every SYNCED setting and its default , the baseline the server returns when
 *  no row exists, and the merge floor on every read/write so a field added after
 *  a row was written falls back sanely.
 *
 *  Device-local settings (e.g. `pushEnabled`, which belongs to one panel's APNs
 *  token and can never be a global truth) are NOT here; web layers those on top. */
export const SETTINGS_DEFAULTS = {
  activeBrightness: 1,
  idleDimEnabled: true,
  idleDimTimeoutMs: 600_000,
  idleDimLevel: 0.25,
  lockScreenEnabled: true,
  lockScreenBlurPercent: 10,
  showFps: false,
  showBuildBadge: true,
  showBuildNumber: false,
  snapMode: "mandatory-settle",
  showMinimap: true,
  pinCode: "000000",
  // Ships at the strongest key (#302): one glimpsed screen costs a single digit
  // here and the whole PIN under any layout that holds still for the entry. The
  // per-unlock cost is a re-scan per digit, and that trade was asked for.
  //
  // A default is not a migration. It applies only where no stored value exists ,
  // the server merges the stored blob OVER this map , so an already-provisioned
  // panel keeps what it has. Verified 2026-07-28: the live panel reads `rotated`,
  // so this deploy ships the option and changes nothing it does. Moving an
  // existing panel is a deliberate write. Raising a default is only safe in this
  // direction anyway , a panel already locked the stronger way must never be
  // quietly weakened by a deploy.
  pinPadLayout: "scrambled-per-key",
  accent: "white",
  typeface: "sf",
  timeZone: DEFAULT_TIME_ZONE,
} as const satisfies Record<string, unknown>;
