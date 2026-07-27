/**
 * kiosk-browser , the web side of the iOS KioskBrowser plugin
 * (ios/App/App/KioskBrowserPlugin.swift).
 *
 * Presents a URL in a WKWebView the native side owns and presents modally,
 * with only a "Done" button , no share sheet, no "open in Safari" escape.
 * Replaces @capacitor/browser (SFSafariViewController) as the target of
 * external-browser.ts's openExternalUrl, which is the whole point (#56): the
 * OS-provided browser sheet has an "open in Safari.app" button with no API to
 * hide it, and that button exits the kiosk shell entirely.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";
import { log } from "./log/logger";

const kioskBrowserLog = log.child("kiosk-browser");

interface KioskBrowserPlugin {
  open(options: { url: string }): Promise<void>;
  close(): Promise<void>;
  addListener(
    event: "browserFinished",
    handler: () => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const plugin = registerPlugin<KioskBrowserPlugin>("KioskBrowser");

/** Whether this build can actually present the native browser. False in a
 *  browser, Storybook, CI, and any native build predating the plugin. */
export function isKioskBrowserAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("KioskBrowser");
}

/** Present `url` in the owned in-app browser. */
export async function openKioskBrowser(url: string): Promise<void> {
  await plugin.open({ url });
}

/** Dismiss the currently-presented browser, if any; a no-op otherwise. */
export async function closeKioskBrowser(): Promise<void> {
  try {
    await plugin.close();
  } catch (err) {
    kioskBrowserLog.warn("close failed", { err: String(err) });
  }
}

/** Subscribe to the browser being dismissed (Done tap or close()). Returns an
 *  unsubscribe fn. Mirrors @capacitor/browser's browserFinished contract. */
export function onKioskBrowserFinished(handler: () => void): () => void {
  let remove: (() => Promise<void>) | null = null;
  let cancelled = false;
  void plugin
    .addListener("browserFinished", handler)
    .then((handle) => {
      if (cancelled) return void handle.remove();
      remove = handle.remove;
    })
    .catch((err) => {
      kioskBrowserLog.warn("listener registration failed", { err: String(err) });
    });
  return () => {
    cancelled = true;
    void remove?.();
  };
}
