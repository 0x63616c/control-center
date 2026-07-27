// Kiosk auto-refresh (www-ss8s). The iPad wall panel is a Capacitor WKWebView
// kiosk with the idle timer disabled, so it never reloads on its own and keeps
// serving whatever bundle it first loaded. OTA web deploys therefore never
// appear until a manual reload. This polls a build-stamped `version.json`
// (emitted at build with the SAME SHA baked into the running bundle) and reloads
// once when the deployed SHA no longer matches the running one.

import { BUILD_HASH } from "../config/build";
import { log } from "./log/logger";
import { setUpdatePending } from "./update-pending-store";

const versionLog = log.child("version-check");

// How often to poll version.json. 10s per Calum , fast enough that a deploy
// lands on the panel within seconds, cheap enough as a static GET on the kiosk.
export const VERSION_POLL_MS = 10_000;

// Grace period between detecting a mismatch and actually reloading, so
// UpdateReloadBanner has time to paint , a reload that fires the instant the
// panel returns from an external view (e.g. dismissing the deploy pipeline's
// in-app browser) previously looked indistinguishable from a crash.
export const RELOAD_GRACE_MS = 1200;

// Path of the build-stamped version file. nginx serves dist at site root, so the
// build's dist/version.json is reachable here.
const VERSION_URL = "/version.json";

export interface VersionCheckOptions {
  // Injected so the loop is unit-testable; defaults to a hard reload. Wired to
  // window.location.reload() at the call site.
  reload?: () => void;
  // Override for tests; defaults to the SHA baked into the running bundle.
  currentHash?: string;
  poll?: number;
  url?: string;
  // Override for tests; defaults to RELOAD_GRACE_MS.
  reloadDelay?: number;
}

// Starts the version-check loop. Returns a stop() that clears the timer and
// detaches the visibility/online listeners. Does nothing in local dev
// (BUILD_HASH === "dev"): version.json won't exist and we'd reload-loop.
export function startVersionCheck(options: VersionCheckOptions = {}): () => void {
  const currentHash = options.currentHash ?? BUILD_HASH;
  const reload = options.reload ?? (() => window.location.reload());
  const poll = options.poll ?? VERSION_POLL_MS;
  const url = options.url ?? VERSION_URL;
  const reloadDelay = options.reloadDelay ?? RELOAD_GRACE_MS;

  // Local dev builds have no deployed version.json and a synthetic "dev" hash;
  // polling would either 404 forever or, worse, reload-loop. Skip entirely.
  if (currentHash === "dev") {
    return () => {};
  }

  // Guards a slow reload from looping: once a mismatch fires reload, every later
  // tick is a no-op (the page is on its way out, but the timer may still tick).
  let reloadTriggered = false;

  async function check(): Promise<void> {
    if (reloadTriggered) return;
    try {
      // Cache-bust both via no-store and a query param , WKWebView and
      // intermediaries are aggressive about caching same-URL JSON.
      const res = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { hash?: unknown };
      if (typeof data.hash !== "string") return;
      if (data.hash !== currentHash && !reloadTriggered) {
        reloadTriggered = true;
        versionLog.info("update detected, reloading", {
          from: currentHash,
          to: data.hash,
          delayMs: reloadDelay,
        });
        setUpdatePending(true);
        setTimeout(() => {
          versionLog.info("reloading now");
          reload();
        }, reloadDelay);
      }
    } catch {
      // Swallow all network/parse errors: the kiosk keeps running and retries
      // on the next tick.
    }
  }

  const interval = setInterval(check, poll);

  // Re-check immediately when the panel becomes visible again or the network
  // comes back, so a deploy that landed while the tab was hidden/offline is
  // picked up without waiting a full poll interval.
  const onVisible = () => {
    if (document.visibilityState === "visible") void check();
  };
  const onOnline = () => void check();

  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);

  return () => {
    clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onOnline);
  };
}
