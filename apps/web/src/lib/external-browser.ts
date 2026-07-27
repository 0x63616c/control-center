/**
 * external-browser , open a URL in the panel's own in-app browser and keep
 * the board's idle reset honest about it.
 *
 * On iOS this is KioskBrowserPlugin: a WKWebView we present modally, whose
 * only chrome is a "Done" button we add ourselves , no share sheet, no
 * "open in Safari" escape (see kiosk-browser.ts and #56). Because it's our
 * own view, our webview keeps receiving events while it's up; we still
 * register it as a dismissable modal (see modal-open-store) purely so the
 * board's idle reset can close it out from under an abandoned panel, same as
 * every other modal , an abandoned panel MUST find its way back to the
 * clock.
 */

import { Capacitor } from "@capacitor/core";
import {
  closeKioskBrowser,
  isKioskBrowserAvailable,
  onKioskBrowserFinished,
  openKioskBrowser,
} from "./kiosk-browser";
import { log } from "./log/logger";
import { registerOpenModal } from "./modal-open-store";

const externalBrowserLog = log.child("external-browser");

// Disposers for the in-flight browser session's modal registration and
// browserFinished listener. Held at module scope because open/close are
// separate user gestures: `close()` is driven by the native "Done" button
// (browserFinished) or by the idle reset, not by the caller that opened it.
let releaseModal: (() => void) | null = null;
let unsubscribeFinished: (() => void) | null = null;

function cleanup(): void {
  releaseModal?.();
  releaseModal = null;
  unsubscribeFinished?.();
  unsubscribeFinished = null;
}

/**
 * Open `url` in the in-app browser. Off-device (browser dev, Storybook) there
 * is no native browser plugin, so fall back to a plain new tab and skip the
 * modal registration entirely , the idle reset is native-only anyway.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  // The web bundle ships OTA ahead of the native shell (see version-check.ts),
  // so there's a window where a panel is running new JS against an old native
  // build that predates this plugin. Refuse rather than silently doing
  // nothing or falling back to a Safari escape hatch , the kiosk-escape fix
  // this plugin exists for only holds once the native build has landed too.
  if (!isKioskBrowserAvailable()) {
    externalBrowserLog.warn("KioskBrowser plugin unavailable, refusing to open", { url });
    return;
  }

  // Re-entrancy: a second tap while one is already open must not leak the
  // first registration and pin the board's modal count above zero forever.
  cleanup();

  // Registered BEFORE the open await so an idle reset landing mid-present
  // still finds a dismisser to call.
  releaseModal = registerOpenModal(() => {
    void closeKioskBrowser();
  });

  // Fires when the sheet is dismissed by any route , the "Done" button, or
  // our own closeKioskBrowser() from the idle reset.
  unsubscribeFinished = onKioskBrowserFinished(cleanup);

  try {
    await openKioskBrowser(url);
  } catch (err) {
    // The sheet never came up, so browserFinished will never fire to balance
    // the registration.
    cleanup();
    throw err;
  }
}
