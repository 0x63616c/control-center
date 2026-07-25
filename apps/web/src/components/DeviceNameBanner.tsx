import { useDeviceName } from "../lib/device-name";
import { NotificationBanner } from "./ui/NotificationBanner";

// Single source of truth for the copy shown in the view below.
const MESSAGE = "Please set your device name in settings";

/**
 * Un-dismissable RED banner (top-right inside .board) shown until the user has
 * explicitly set a device name.
 *
 * Ticket #63: this used to also raise into the shared notifications store
 * (like ConnectionLostBanner / AppUpdateBanner), which meant a one-time setup
 * nag was creating a persistent `notifications.raise` row every time it fired.
 * It is now a pure presentational read of useDeviceName().isSet with no
 * notification-center side effect , the live board banner is signal enough for
 * a thing you fix once during setup.
 *
 * There is intentionally NO dismiss control and no clear path other than the
 * name becoming set , the banner exists to force the one-time setup, so it must
 * not be silence-able.
 */
export function DeviceNameBanner() {
  const { isSet } = useDeviceName();

  if (isSet) return null;

  return <DeviceNameBannerView />;
}

/** Presentational banner, exported for Storybook. */
export function DeviceNameBannerView() {
  // Critical one-time setup nag → assertive so it interrupts.
  return (
    <NotificationBanner tone="red" role="alert" ariaLive="assertive">
      {MESSAGE}
    </NotificationBanner>
  );
}
