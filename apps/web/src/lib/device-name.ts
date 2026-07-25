/**
 * Per-device name , a dependency-light singleton store for the human-readable
 * name this particular panel/browser carries (e.g. "iPad", "Calum's Laptop").
 *
 * Mirrors the useSyncExternalStore shape of lib/settings.ts and
 * lib/useNotifications.ts (module-level state + a listener set + a hook), so the
 * settings input, the "please set your name" banner, and the logger all read one
 * live source of truth without prop-drilling.
 *
 * DELIBERATELY NOT folded into lib/device-settings.ts (ticket #63). The name
 * used to be strictly local-only ("must never leave the browser"); that turned
 * out to be wrong , without a server copy the name is invisible off-device and
 * lost on reinstall, exactly the gap device-settings.ts's volume field solved
 * for panel preferences generally. Rather than adding a `name` field to that
 * store's KEYS/DEFAULTS (which would give two stores unconditional
 * write-every-key hydration over the SAME localStorage key, a real clobber
 * hazard), this store stays the sole owner of both `cc-device-name` keys and
 * grows its own bespoke, name-scoped sink , see `registerNameServerSink` below
 * , wired up by useDeviceSettingsSync.ts alongside its existing volume sink.
 *
 * Two localStorage keys, on purpose (a separate-key design, not a sentinel):
 *   - `cc-device-name`      the USER-set name. Absent until the user explicitly
 *                           sets one; its presence (non-empty) is the sole
 *                           "user has chosen a name" signal.
 *   - `cc-device-name-auto` the derived default, persisted once so the effective
 *                           name is stable across reloads even if UA parsing
 *                           later changes.
 * The effective name (used for logs + display) is the user value if set, else
 * the auto default , so it is never empty, while "user has not chosen one" stays
 * independently detectable for the banner.
 *
 * A THIRD key, `cc-device-name-migrated`, is a one-shot flag (see
 * `markDeviceNameMigrated`/`nameToMigrate`) covering the upgrade case: a panel
 * that already had a local name before this ticket shipped needs that name
 * pushed to the server exactly once. It is set on any resolved outcome
 * (pushed, or nothing to migrate) so an over-length legacy name is not retried
 * every reload once it has been truncated and pushed.
 *
 * MUST NOT statically import log/logger.ts: the logger imports getDeviceName()
 * to stamp every line, so a static import back would form a cycle. (A lazy
 * dynamic import inside a setter would be fine, but we do not log name changes.)
 */

import { NAME_MAX_LENGTH } from "@cc/api/device-settings";
import { createStore, useStore } from "./store";

const USER_KEY = "cc-device-name";
const AUTO_KEY = "cc-device-name-auto";
const MIGRATED_KEY = "cc-device-name-migrated";

/** Honest last resort when there is no UA to derive from (SSR / locked-down env). */
const UNKNOWN_DEVICE = "unknown-device";

// ─── best-effort localStorage IO (guarded , SSR/tests/private-mode Safari) ─────

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
    // persistence is best-effort (blocked / full store)
  }
}

function removeRaw(key: string): void {
  try {
    window.localStorage?.removeItem(key);
  } catch {
    // best-effort
  }
}

function readNavigator(): { userAgent: string; platform: string } {
  try {
    return {
      userAgent: navigator.userAgent ?? "",
      // `platform` is deprecated but still the most reliable iPad/Mac hint on
      // WebKit; a missing value simply drops out of the haystack below.
      platform: navigator.platform ?? "",
    };
  } catch {
    return { userAgent: "", platform: "" };
  }
}

// ─── default derivation (pure, deterministic, unit-testable) ───────────────────

function detectOs(haystack: string): string {
  if (/Android/i.test(haystack)) return "Android";
  if (/CrOS/i.test(haystack)) return "ChromeOS";
  if (/Windows/i.test(haystack)) return "Windows";
  if (/Mac OS X|Macintosh|MacIntel/i.test(haystack)) return "macOS";
  if (/Linux/i.test(haystack)) return "Linux";
  return "";
}

function detectBrowser(ua: string): string {
  // Order matters: Edge/Opera masquerade as Chrome, Chrome masquerades as Safari.
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "";
}

/**
 * A short, readable slug from the user agent + platform, e.g. "iPad", "iPhone",
 * "Chrome-macOS". Pure: the navigator values default in but can be passed for
 * tests. Never empty , falls back to `unknown-device` when nothing is known.
 */
export function deriveDefaultName(
  ua: string = readNavigator().userAgent,
  platform: string = readNavigator().platform,
): string {
  const haystack = `${ua} ${platform}`;
  if (/iPad/i.test(haystack)) return "iPad";
  if (/iPhone/i.test(haystack)) return "iPhone";
  if (/iPod/i.test(haystack)) return "iPod";

  const os = detectOs(haystack);
  const browser = detectBrowser(ua);
  if (browser && os) return `${browser}-${os}`;
  if (os) return os;
  if (browser) return browser;
  return UNKNOWN_DEVICE;
}

// ─── singleton store ───────────────────────────────────────────────────────────

/**
 * The effective name is read on EVERY log write, so it is cached in a module var
 * and only recomputed when the user sets/clears the name. `null` = not yet
 * computed (recompute on next read).
 */
let cache: string | null = null;

function resolveAuto(): string {
  const stored = readRaw(AUTO_KEY);
  if (stored?.trim()) return stored;
  // Generate + persist the auto default on first read so it stays stable across
  // reloads (req: sensible default that does not drift with UA-parser changes).
  const derived = deriveDefaultName() || UNKNOWN_DEVICE;
  writeRaw(AUTO_KEY, derived);
  return derived;
}

function resolveName(): string {
  const user = readRaw(USER_KEY);
  if (user?.trim()) return user;
  return resolveAuto();
}

/** Effective name: user value if set, else the persisted auto default. Cheap (cached). */
export function getDeviceName(): string {
  if (cache !== null) return cache;
  cache = resolveName();
  return cache;
}

/** True iff the user has explicitly set a non-empty name (drives the banner). */
export function isDeviceNameSet(): boolean {
  const user = readRaw(USER_KEY);
  return Boolean(user?.trim());
}

/**
 * Set (or, with empty/whitespace input, clear) the user name. Clearing reverts
 * the effective name to the auto default and re-shows the banner.
 */
export interface DeviceNameState {
  name: string;
  isSet: boolean;
}

function snapshotNow(): DeviceNameState {
  return { name: getDeviceName(), isSet: isDeviceNameSet() };
}

// Recomputed only on a real write so useStore consumers get a referentially
// stable snapshot between changes (no re-render storm on unrelated updates).
const store = createStore<DeviceNameState>(snapshotNow());

// Optional server sink, registered by useDeviceSettingsSync. Null when
// unmounted / in tests / Storybook , the store is then local-only, same
// pattern as device-settings.ts's serverSink but scoped to just the name.
let serverSink: ((name: string) => void) | null = null;

/** Register the server pusher; returns an unregister fn. */
export function registerNameServerSink(fn: (name: string) => void): () => void {
  serverSink = fn;
  return () => {
    if (serverSink === fn) serverSink = null;
  };
}

export function setDeviceName(name: string): void {
  if (name.trim()) {
    writeRaw(USER_KEY, name);
  } else {
    removeRaw(USER_KEY);
  }
  cache = null; // recompute lazily on next getDeviceName()
  store.set(snapshotNow());
  serverSink?.(readRaw(USER_KEY) ?? "");
}

// ─── server sync (ticket #63) ───────────────────────────────────────────────

/**
 * Adopt an authoritative name the SERVER reported, without echoing back. A
 * no-op when `serverName` is empty (that case is the migration's job, not
 * this function's , see `nameToMigrate`) or matches what is already local.
 */
export function hydrateDeviceName(serverName: string): void {
  const trimmed = serverName.trim();
  if (!trimmed) return;
  if (readRaw(USER_KEY) === trimmed) return;
  writeRaw(USER_KEY, trimmed);
  cache = null;
  store.set(snapshotNow());
}

function hasMigrated(): boolean {
  return readRaw(MIGRATED_KEY) === "1";
}

/** Mark the one-time upward migration resolved, so it is never retried. */
export function markDeviceNameMigrated(): void {
  writeRaw(MIGRATED_KEY, "1");
}

/**
 * The one-time upward migration check: a panel that already had a local name
 * before server-side persistence existed needs that name pushed up once.
 *
 * Returns the local name (truncated to NAME_MAX_LENGTH) to push iff migration
 * has not already resolved, the server has no name yet, and the user has
 * actually set one locally. Otherwise marks migration resolved (there is
 * nothing to do) and returns null , this is what stops a legacy name that will
 * never validate server-side from being retried on every reload.
 */
export function nameToMigrate(serverName: string): string | null {
  if (hasMigrated()) return null;
  if (serverName.trim()) {
    markDeviceNameMigrated();
    return null;
  }
  if (!isDeviceNameSet()) {
    markDeviceNameMigrated();
    return null;
  }
  const local = readRaw(USER_KEY) ?? "";
  return local.slice(0, NAME_MAX_LENGTH);
}

/**
 * Subscribe to the live device name. `name` is the effective name (never empty);
 * `isSet` is whether the user has chosen one. Setters are module-level exports.
 */
export function useDeviceName(): DeviceNameState {
  return useStore(store);
}

/** Test seam: forget the cached name + snapshot so a test can start clean. */
export function resetDeviceNameForTests(): void {
  cache = null;
  store.set(snapshotNow());
}

/** Test seam: read the migration flag directly, without going through a poll. */
export function hasMigratedForTests(): boolean {
  return hasMigrated();
}
