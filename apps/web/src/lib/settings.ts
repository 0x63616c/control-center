/**
 * Wall-panel settings , a singleton external store for the small set of
 * on-device preferences the settings gear panel edits (idle-dim behavior, the
 * FPS readout, the snap-mode experiment). Mirrors useNotifications.ts: one
 * module-level state object, a listener set, and useSyncExternalStore, so any
 * component (the panel, the board, the FPS meter, the idle-dim hook) reads the
 * same live values without prop-drilling or a state library.
 *
 * Persistence follows the board's existing `cc-*` localStorage convention
 * (loadSnapMode in Board.tsx): every write is best-effort and guarded, since
 * localStorage is absent in SSR/test envs and throws in private-mode Safari.
 */

import {
  ACCENTS,
  type Accent,
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  DIM_MAX,
  DIM_MIN,
  LOCK_SCREEN_BLUR_MAX_PERCENT,
  LOCK_SCREEN_BLUR_MIN_PERCENT,
  PIN_PAD_LAYOUTS,
  type PinPadLayout,
  SETTINGS_DEFAULTS,
  SNAP_MODES,
  type SnapMode,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
  TYPEFACES,
  type Typeface,
} from "@cc/api/settings";
import { interaction } from "./log/interaction";
import { log } from "./log/logger";
import { createStore, useStore } from "./store";

// Every panel setting that changes is a candidate explanation for "why is the
// board behaving like that" , cheap to record, and the alternative is guessing.
const settingsLog = log.child("settings");

// ─── snap-mode vocabulary (shared with Board) ─────────────────────────────────
// The board A/B-tests how it settles. The mode LIST is the wire contract and
// lives in @cc/api/settings so the server's zod enum and this store cannot
// drift; it is re-exported here so board + settings panel keep importing their
// vocabulary from one place. The CSS mapping stays in Board.tsx (a rendering
// concern) and the human-facing LABELS stay here (UI vocabulary the API has no
// opinion on).
export { SNAP_MODES, type SnapMode };
export const SNAP_MODE_LABEL: Record<SnapMode, string> = {
  proximity: "gentle",
  mandatory: "paged",
  "mandatory-settle": "paged+",
  none: "off",
  spring: "spring (old)",
};

// ─── PIN-pad layout vocabulary ────────────────────────────────────────────────
// Same split as snap modes: the KEY list is wire contract (@cc/api/settings), the
// human labels are UI vocabulary and live here.
export { PIN_PAD_LAYOUTS, type PinPadLayout };
export const PIN_PAD_LAYOUT_LABEL: Record<PinPadLayout, string> = {
  fixed: "fixed",
  rotated: "rotated",
  scrambled: "scrambled",
  // Not "scrambled per key" , four segments share one row on a fixed 1366px
  // panel, and the qualifier is the only part that distinguishes this from its
  // neighbour. The blurb under the control carries the rest.
  "scrambled-per-key": "per keypress",
};

// ─── settings shape + bounds ──────────────────────────────────────────────────

export interface Settings {
  /** Active (awake) backlight the panel drives itself, overriding whatever the
   *  OS brightness slider is set to. Clamped to [0.01, 1] (1%..100%). Idle
   *  dimming drops from here down to idleDimLevel. */
  activeBrightness: number;
  /** When true, the panel dims after the idle window; false disables dimming. */
  idleDimEnabled: boolean;
  /** Idle window before dimming, in ms. Clamped to [1min, 60min]. */
  idleDimTimeoutMs: number;
  /** Dim target as a 0..1 brightness fraction. Clamped to [0.01, 0.99]. */
  idleDimLevel: number;
  /** Whether idle dimming presents a PIN-gated lock screen. */
  lockScreenEnabled: boolean;
  /** Backdrop blur strength for the idle lock screen, 0–100%. */
  lockScreenBlurPercent: number;
  /** Show the live FPS readout (top-right). */
  showFps: boolean;
  /** Show the build-hash + age badge (bottom-left). */
  showBuildBadge: boolean;
  /** Show the native app build number badge (bottom-left, above the git-sha
   *  badge). Opt-in, native-only meaning (null off-device). */
  showBuildNumber: boolean;
  /** Board settle feel (see SNAP_MODES). */
  snapMode: SnapMode;
  /** Show the board minimap (bottom-right). */
  showMinimap: boolean;
  /** Synced 6-digit PIN gating Settings + PIN-gated detail pages (e.g.
   *  Activity); the gates are always on.
   *  NOT auth , purely a frontend soft-lock. Exactly 6 digits; default "000000". */
  pinCode: string;
  /** How the PIN pad arranges its digits (#287, #291, #302). A `fixed` pad wears
   *  grease into the same four keys, which narrows a 6-digit PIN to the orderings
   *  of whichever digits are smudged; `rotated` and `scrambled` both move the
   *  digits per prompt so the wear spreads across all ten, and
   *  `scrambled-per-key` moves them after every digit, which additionally makes
   *  watching the finger useless. See PIN_PAD_LAYOUTS for what each costs. */
  pinPadLayout: PinPadLayout;
  /** The single highlight colour the board is built around (see lib/accent.ts).
   *  Synced, not device-local: the accent is how the installation looks, not a
   *  property of one panel. */
  accent: Accent;
  /** The board's type pair , sans + its mono, plus the weights and tracking
   *  that face needs (see lib/typeface.ts). Synced for the same reason as the
   *  accent: it is how the installation looks, not a property of one panel. */
  typeface: Typeface;
  /** Push notifications requested for THIS device. Drives the OS permission
   *  prompt + APNs token registration (lib/push.ts). Device-local by nature:
   *  a token belongs to one panel, so this must not sync across panels. */
  pushEnabled: boolean;
}

// The bounds are wire contract , the server validates against these same numbers
// , so they are re-exported from @cc/api/settings rather than restated. The
// local aliases keep the names this module's consumers (the settings sliders)
// already import.
export const MIN_IDLE_TIMEOUT_MS = TIMEOUT_MIN_MS; // 1 min
export const MAX_IDLE_TIMEOUT_MS = TIMEOUT_MAX_MS; // 10 min
export const MIN_DIM_LEVEL = DIM_MIN; // 1 %
export const MAX_DIM_LEVEL = DIM_MAX; // 99 %
export const MIN_BRIGHTNESS = BRIGHTNESS_MIN; // 1 %
export const MAX_BRIGHTNESS = BRIGHTNESS_MAX; // 100 %
export const MIN_LOCK_SCREEN_BLUR_PERCENT = LOCK_SCREEN_BLUR_MIN_PERCENT;
export const MAX_LOCK_SCREEN_BLUR_PERCENT = LOCK_SCREEN_BLUR_MAX_PERCENT;
export const PIN_LENGTH = 6;
export const DEFAULT_PIN = SETTINGS_DEFAULTS.pinCode;

// The synced defaults come from the contract; this spread states the DELTA , the
// device-local fields the server has no opinion on (see LOCAL_ONLY_KEYS). Adding
// a local-only setting means adding it here and nowhere else.
const DEFAULTS: Settings = {
  ...SETTINGS_DEFAULTS,
  pushEnabled: false,
};

// `cc-board-snap-mode` is reused verbatim so an existing SnapModeSwitcher choice
// migrates into the store with no data loss.
const KEYS = {
  activeBrightness: "cc-active-brightness",
  idleDimEnabled: "cc-idle-dim-enabled",
  idleDimTimeoutMs: "cc-idle-dim-timeout-ms",
  idleDimLevel: "cc-idle-dim-level",
  lockScreenEnabled: "cc-lock-screen-enabled",
  lockScreenBlurPercent: "cc-lock-screen-blur-percent",
  showFps: "cc-show-fps",
  showBuildBadge: "cc-show-build-badge",
  showBuildNumber: "cc-show-build-number",
  snapMode: "cc-board-snap-mode",
  showMinimap: "cc-show-minimap",
  pinCode: "cc-pin-code",
  pinPadLayout: "cc-pin-pad-layout",
  accent: "cc-accent",
  typeface: "cc-typeface",
  pushEnabled: "cc-push-enabled",
} as const;

/**
 * Fields the SERVER does not know about, so a poll must never overwrite them.
 *
 * `settings.get` returns a zod-validated object; a field the API's schema has no
 * key for is simply absent from the response, and `hydrateSettings` would then
 * fold in the DEFAULT and wipe what the user just chose (within one 15s poll).
 * Listing a field here keeps hydration from touching it, so it behaves as a
 * device-local preference until (and unless) the API grows the same key.
 *
 * `pushEnabled` is device-local BY DESIGN, not merely pending: an APNs token
 * belongs to one panel, so "push on" can never be a global truth.
 */
const LOCAL_ONLY_KEYS = new Set<keyof Settings>(["pushEnabled"]);

// ─── clamps ───────────────────────────────────────────────────────────────────

function clampIdleTimeoutMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULTS.idleDimTimeoutMs;
  return Math.min(MAX_IDLE_TIMEOUT_MS, Math.max(MIN_IDLE_TIMEOUT_MS, Math.round(ms)));
}

export function clampDimLevel(level: number): number {
  if (!Number.isFinite(level)) return DEFAULTS.idleDimLevel;
  return Math.min(MAX_DIM_LEVEL, Math.max(MIN_DIM_LEVEL, level));
}

export function clampBrightness(level: number): number {
  if (!Number.isFinite(level)) return DEFAULTS.activeBrightness;
  return Math.min(MAX_BRIGHTNESS, Math.max(MIN_BRIGHTNESS, level));
}

function clampLockScreenBlurPercent(percent: number): number {
  if (!Number.isFinite(percent)) return DEFAULTS.lockScreenBlurPercent;
  return Math.min(
    MAX_LOCK_SCREEN_BLUR_PERCENT,
    Math.max(MIN_LOCK_SCREEN_BLUR_PERCENT, Math.round(percent)),
  );
}

// ─── best-effort localStorage IO ──────────────────────────────────────────────

function readRaw(key: string): string | null {
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    // ignore , persistence is best-effort (blocked/full store)
  }
}

function loadInitial(): Settings {
  // One-time sweep of keys retired with the idle-recenter settings (Track B):
  // deployed panels otherwise carry them forever. Remove after a few releases.
  try {
    window.localStorage?.removeItem("cc-recenter-enabled");
    window.localStorage?.removeItem("cc-recenter-timeout-ms");
  } catch {
    // ignore , best-effort, same as every other storage touch here
  }
  const brightness = readRaw(KEYS.activeBrightness);
  const enabled = readRaw(KEYS.idleDimEnabled);
  const timeout = readRaw(KEYS.idleDimTimeoutMs);
  const level = readRaw(KEYS.idleDimLevel);
  const lockScreenEnabled = readRaw(KEYS.lockScreenEnabled);
  const lockScreenBlurPercent = readRaw(KEYS.lockScreenBlurPercent);
  const fps = readRaw(KEYS.showFps);
  const snap = readRaw(KEYS.snapMode);
  const buildBadge = readRaw(KEYS.showBuildBadge);
  const buildNumber = readRaw(KEYS.showBuildNumber);
  const minimap = readRaw(KEYS.showMinimap);
  const pin = readRaw(KEYS.pinCode);
  const pinPadLayout = readRaw(KEYS.pinPadLayout);
  // `cc-scramble-pin` was this setting's boolean ancestor (#287, one release).
  // A panel that had deliberately turned scrambling OFF must not silently get
  // the new default back; read the old key when the new one is absent.
  const legacyScramble = readRaw("cc-scramble-pin");
  const accent = readRaw(KEYS.accent);
  const typeface = readRaw(KEYS.typeface);
  const push = readRaw(KEYS.pushEnabled);
  return {
    activeBrightness:
      brightness === null ? DEFAULTS.activeBrightness : clampBrightness(Number(brightness)),
    idleDimEnabled: enabled === null ? DEFAULTS.idleDimEnabled : enabled === "true",
    idleDimTimeoutMs:
      timeout === null ? DEFAULTS.idleDimTimeoutMs : clampIdleTimeoutMs(Number(timeout)),
    idleDimLevel: level === null ? DEFAULTS.idleDimLevel : clampDimLevel(Number(level)),
    lockScreenEnabled:
      lockScreenEnabled === null ? DEFAULTS.lockScreenEnabled : lockScreenEnabled === "true",
    lockScreenBlurPercent:
      lockScreenBlurPercent === null
        ? DEFAULTS.lockScreenBlurPercent
        : clampLockScreenBlurPercent(Number(lockScreenBlurPercent)),
    showFps: fps === null ? DEFAULTS.showFps : fps === "true",
    showBuildBadge: buildBadge === null ? DEFAULTS.showBuildBadge : buildBadge === "true",
    showBuildNumber: buildNumber === null ? DEFAULTS.showBuildNumber : buildNumber === "true",
    snapMode:
      snap && (SNAP_MODES as readonly string[]).includes(snap)
        ? (snap as SnapMode)
        : DEFAULTS.snapMode,
    showMinimap: minimap === null ? DEFAULTS.showMinimap : minimap === "true",
    pinCode: pin && /^\d{6}$/.test(pin) ? pin : DEFAULTS.pinCode,
    pinPadLayout:
      pinPadLayout && (PIN_PAD_LAYOUTS as readonly string[]).includes(pinPadLayout)
        ? (pinPadLayout as PinPadLayout)
        : legacyScramble === "false"
          ? "fixed"
          : DEFAULTS.pinPadLayout,
    accent:
      accent && (ACCENTS as readonly string[]).includes(accent)
        ? (accent as Accent)
        : DEFAULTS.accent,
    typeface:
      typeface && (TYPEFACES as readonly string[]).includes(typeface)
        ? (typeface as Typeface)
        : DEFAULTS.typeface,
    pushEnabled: push === null ? DEFAULTS.pushEnabled : push === "true",
  };
}

// ─── singleton store ──────────────────────────────────────────────────────────

const store = createStore<Settings>(loadInitial());

// Optional server sink: the sync hook (useSettingsSync) registers a pusher so a
// user edit also persists globally, syncing across every wall panel. Null when
// unmounted / in tests / Storybook , the store then behaves local-only.
let serverSink: ((s: Settings) => void) | null = null;

/** Register the server pusher; returns an unregister fn. */
export function registerServerSink(fn: (s: Settings) => void): () => void {
  serverSink = fn;
  return () => {
    if (serverSink === fn) serverSink = null;
  };
}

function shallowEqual(a: Settings, b: Settings): boolean {
  for (const key of Object.keys(KEYS) as (keyof Settings)[]) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

// Replace state only when the value actually changes so useSyncExternalStore
// consumers don't re-render on no-op writes (referential stability). A user edit
// (patch) also pushes to the server sink so the change syncs to other panels.
function patch<K extends keyof Settings>(key: K, value: Settings[K], serialized: string): void {
  const state = store.get();
  if (state[key] === value) return;
  settingsLog.info(`${key} changed`, { from: state[key], to: value });
  // Also on the human-activity channel. `patch` is reached ONLY from the setters
  // a control calls, never from `hydrateSettings` (the server poll), so every
  // call here is genuinely someone touching the Settings panel , which is
  // exactly the human-origin-only rule this channel depends on.
  interaction("settings", "change", `settings.${key}`, { from: state[key], to: value });
  const next = { ...state, [key]: value };
  writeRaw(KEYS[key], serialized);
  store.set(next);
  serverSink?.(next);
}

/** Drop explicitly-undefined keys so a spread cannot punch a hole in `state`
 *  , `{...state, ...{ snapMode: undefined }}` would otherwise yield undefined. */
function stripUndefined(next: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {};
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * Adopt authoritative settings from the server WITHOUT echoing back to it (no
 * sink call), used on load + each poll. Writes through to the localStorage cache
 * so an offline reload keeps the last-known global values.
 *
 * A field the response OMITS keeps this panel's current value rather than
 * falling back to its default. The two differ exactly during a deploy skew ,
 * web ships a new setting before the api knows the key, so `settings.get`
 * (a zod object, which strips what it has no key for) returns it missing, and
 * defaulting here would undo the user's choice on the next 15s poll. Keeping
 * the current value degrades to "device-local until the api catches up", which
 * is the same shape as LOCAL_ONLY_KEYS below and needs no per-field bookkeeping.
 */
export function hydrateSettings(next: Partial<Settings>): void {
  const state = store.get();
  const merged: Settings = { ...DEFAULTS, ...state, ...stripUndefined(next) };
  // Local-only fields keep whatever this panel has; the server has no opinion on
  // them, and folding in the DEFAULT here would silently undo a user's choice on
  // the next poll (see LOCAL_ONLY_KEYS).
  for (const key of LOCAL_ONLY_KEYS) {
    // Assigning through a per-key generic keeps the value's type tied to its
    // key (a blanket Record<string, unknown> cast would erase that).
    const assign = <K extends keyof Settings>(k: K) => {
      merged[k] = state[k];
    };
    assign(key);
  }
  if (shallowEqual(state, merged)) return;
  for (const key of Object.keys(KEYS) as (keyof Settings)[]) {
    writeRaw(KEYS[key], String(merged[key]));
  }
  store.set(merged);
}

// ─── setters (module-level, stable) ───────────────────────────────────────────

export function setActiveBrightness(level: number): void {
  const clamped = clampBrightness(level);
  patch("activeBrightness", clamped, String(clamped));
}

export function setIdleDimEnabled(v: boolean): void {
  patch("idleDimEnabled", v, String(v));
}

export function setIdleDimTimeoutMs(ms: number): void {
  const clamped = clampIdleTimeoutMs(ms);
  patch("idleDimTimeoutMs", clamped, String(clamped));
}

export function setIdleDimLevel(level: number): void {
  const clamped = clampDimLevel(level);
  patch("idleDimLevel", clamped, String(clamped));
}

export function setLockScreenEnabled(value: boolean): void {
  patch("lockScreenEnabled", value, String(value));
}

export function setLockScreenBlurPercent(percent: number): void {
  const clamped = clampLockScreenBlurPercent(percent);
  patch("lockScreenBlurPercent", clamped, String(clamped));
}

// Not exported (#64): the three overlay fields used to have their own Debug-page
// switches, so each setter was public. Debug folded into Device's single
// "Developer overlay" switch (setDeveloperOverlay below), which is now the only
// caller , keep these module-private until something else needs one alone.
function setShowFps(v: boolean): void {
  patch("showFps", v, String(v));
}

function setShowBuildBadge(v: boolean): void {
  patch("showBuildBadge", v, String(v));
}

function setShowBuildNumber(v: boolean): void {
  patch("showBuildNumber", v, String(v));
}

/**
 * Whether the on-board developer overlay HUD should render (#64: the FPS
 * meter, build badge, and build-number badge collapsed into one consolidated
 * HUD driven by one Settings toggle instead of three independent switches).
 * The three underlying fields stay separate , they are synced wire-contract
 * settings (`@control-center/api/contract`), and folding them into a single
 * field would be a server schema migration, not a UI restructure , so the
 * combined toggle is derived (any one on counts as "on") rather than backed
 * by its own field.
 */
export function useDeveloperOverlay(): boolean {
  const settings = useSettings();
  return settings.showFps || settings.showBuildBadge || settings.showBuildNumber;
}

/** Flip all three overlay fields together, so the single Settings switch reads
 *  as one on/off toggle even though it drives three synced fields. */
export function setDeveloperOverlay(v: boolean): void {
  setShowFps(v);
  setShowBuildBadge(v);
  setShowBuildNumber(v);
}

export function setSnapMode(mode: SnapMode): void {
  patch("snapMode", mode, mode);
}

export function setShowMinimap(v: boolean): void {
  patch("showMinimap", v, String(v));
}

/** Set the synced PIN. No-op unless the input is exactly 6 digits , the schema
 *  guard, not auth (a wrong-format value never reaches storage or the server). */
export function setPinCode(pin: string): void {
  if (!/^\d{6}$/.test(pin)) return;
  patch("pinCode", pin, pin);
}

/** Choose how the PIN pad arranges its digits (see Settings.pinPadLayout).
 *  Synced, not device-local: it is a property of how the installation is locked,
 *  not of one panel's screen. */
export function setPinPadLayout(layout: PinPadLayout): void {
  patch("pinPadLayout", layout, layout);
}

/** Set the board's highlight colour. The vars it drives are applied by
 *  lib/useAccentTheme, not here , this stays a plain store write. */
export function setAccent(accent: Accent): void {
  patch("accent", accent, accent);
}

/** Pick the board's type pair (see lib/typeface.ts). */
export function setTypeface(typeface: Typeface): void {
  patch("typeface", typeface, typeface);
}

export function setPushEnabled(v: boolean): void {
  patch("pushEnabled", v, String(v));
}

/**
 * Reset every setting to its default and push the reset to the server sink so it
 * propagates to other panels (same path as a user edit).
 */
export function resetSettings(): void {
  if (shallowEqual(store.get(), DEFAULTS)) return;
  settingsLog.warn("reset to defaults");
  interaction("settings", "commit", "settings.reset");
  const next = { ...DEFAULTS };
  for (const key of Object.keys(KEYS) as (keyof Settings)[]) {
    writeRaw(KEYS[key], String(DEFAULTS[key]));
  }
  store.set(next);
  serverSink?.(next);
}

// ─── hook ─────────────────────────────────────────────────────────────────────

/**
 * Subscribe to the live settings. Setters are module-level exports (stable
 * references), so components import them directly rather than reading them off
 * the hook return.
 */
export function useSettings(): Settings {
  return useStore(store);
}
