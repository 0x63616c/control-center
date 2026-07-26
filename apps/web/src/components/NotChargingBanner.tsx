import { useEffect } from "react";
import { useDeviceName } from "../lib/device-name";
import { useBatteryInfo } from "../lib/useBatteryInfo";
import { useNotifications } from "../lib/useNotifications";
import { NotificationBanner } from "./ui/NotificationBanner";

const NOTIF_ID = "battery-not-charging";
// Single source of truth so the DOM and the shared notifications store stay in
// sync. Named after the device rather than a hardcoded "iPad" so a push landing
// on a phone says which panel is unplugged.
//
// Split into headline + detail because this pair becomes an APNs alert's
// title/body (notification-bridge → apns.buildApnsPayload). iOS renders a
// notification title on ONE line and truncates it hard, so the headline stays
// short enough to survive that ("Kitchen Panel is not charging"), and the
// explanation and the thing to actually go do live in the body, which iOS wraps
// over two lines and expands on long-press.
const message = (deviceName: string) => `${deviceName} is not charging`;
const detail = "Running on battery. Check the dock cable and power adapter.";

/**
 * Prominent red banner (top-right inside .board) shown when the panel's own
 * battery reports it is NOT charging. The wall panel is meant to sit on dock
 * power permanently, so "not charging" is a real fault worth shouting about.
 *
 * Native-only: useBatteryInfo resolves null in a plain browser (dev/Storybook),
 * and null is treated as UNKNOWN (no warning) so a device without a readable
 * battery never raises a false positive. Feeds the shared notifications store
 * (same seam as the other banners) so notification-bridge mirrors it into the
 * persistent Notification Center.
 */
export function NotChargingBanner() {
  // Mounted for the panel's whole lifetime (unlike the settings-page battery
  // row), so this polls every 60s continuously.
  const battery = useBatteryInfo(true);
  const { raiseNotification, clearNotification } = useNotifications();
  // Effective name, never empty (falls back to the platform default).
  const { name: deviceName } = useDeviceName();

  // null = unknown (off-device / unreadable battery) → treat as NOT a warning.
  const notCharging = battery !== null && battery.isCharging === false;

  useEffect(() => {
    if (notCharging) {
      raiseNotification({ id: NOTIF_ID, message: message(deviceName), detail });
    } else {
      clearNotification(NOTIF_ID);
    }
  }, [notCharging, deviceName, raiseNotification, clearNotification]);

  if (!notCharging) return null;

  return <NotChargingBannerView deviceName={deviceName} />;
}

/** Presentational banner, exported for Storybook. */
export function NotChargingBannerView({ deviceName }: { deviceName: string }) {
  // The panel banner has horizontal room the iOS title does not, so it shows
  // both halves: headline first, then the same detail line the push body uses.
  return (
    <NotificationBanner tone="red">
      {message(deviceName)} <span style={{ opacity: 0.75 }}>· {detail}</span>
    </NotificationBanner>
  );
}
