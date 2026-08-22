/**
 * One call that turns logging on, made as the very first thing in main.tsx.
 *
 * Ordering matters and is the whole reason this is a module rather than a few
 * lines in main: capture must be installed before any other import can run a
 * console call or throw, or those entries are lost. Everything after it is
 * best-effort setup that cannot fail the boot.
 */

import { BUILD_HASH, BUILD_TIME } from "../../config/build";
import { resolveDeviceId } from "../device-id";
import { startNativeDiagnostics } from "../native-diagnostics";
import { shortSha } from "../short-sha";
import { queryClient } from "../trpc";
import { installCapture } from "./capture";
import { log, resolveBuild, startFlushing } from "./logger";
import { restoreFromNative } from "./native";
import { installQueryLogging } from "./query-log";
import { startShipping } from "./ship";
import { append, count, requestPersistence } from "./store";

export function initLogging(): void {
  installCapture();
  startFlushing();
  installQueryLogging(queryClient);
  // Drain on-device logs to Postgres after each flush tick. Best-effort and
  // decoupled: a shipping failure never touches logging (see ship.ts). Ships in
  // the browser too (web sessions have a `web-*` device id).
  startShipping();
  startNativeDiagnostics();

  // Warm the two async-resolved identity fields. Both are best-effort and cached;
  // entries captured before they land carry their defaults ("web" build, and the
  // persisted/web-fallback device id), which is the accepted late-resolve
  // contract. `resolveDeviceId` on native replaces the early web-fallback id with
  // the OS-derived one so this device ships under a stable identity.
  void resolveBuild();
  void resolveDeviceId();

  const boot = log.child("boot");
  boot.info("app start", {
    build: shortSha(BUILD_HASH),
    builtAt: Number.isNaN(BUILD_TIME) ? null : new Date(BUILD_TIME).toISOString(),
    // A reload with no navigation entry of type "reload" is a fresh load; the
    // kiosk watchdog's forced reloads show up here as "reload", which is how you
    // tell "the panel restarted itself" from "someone opened the dashboard".
    navigation: performance.getEntriesByType("navigation")[0]?.entryType ?? "unknown",
    reloaded:
      (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)
        ?.type ?? "unknown",
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  });

  void requestPersistence().then((granted) => {
    boot.info(`storage persistence ${granted ? "granted" : "not granted"}`);
  });

  // If WebKit evicted IndexedDB since the last run, refill it from the native
  // mirror (no-op off-device and when the store has rows). Runs before the
  // first flush lands, so "empty" genuinely means "evicted", not "young".
  void restoreFromNative(async () => (await count()) === 0, append).then((restored) => {
    if (restored > 0) boot.info("log history restored from native mirror", { restored });
  });
}
