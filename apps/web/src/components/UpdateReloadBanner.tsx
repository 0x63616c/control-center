import { useEffect } from "react";
import { useUpdatePending } from "../lib/update-pending-store";
import { useNotifications } from "../lib/useNotifications";
import { NotificationBanner } from "./ui/NotificationBanner";

const NOTIF_ID = "app-reload-pending";
const MESSAGE = "Updating…";

/**
 * Absolutely-positioned banner (top-right inside .board, same slot as
 * ConnectionLostBanner/AppUpdateBanner) shown for the brief RELOAD_GRACE_MS
 * window between version-check.ts detecting a new deploy and the hard reload
 * it schedules. Without this, the reload landed silently , especially jarring
 * right after dismissing the deploy pipeline's in-app browser, where it read
 * as the app crashing rather than updating.
 */
export function UpdateReloadBanner() {
  const pending = useUpdatePending();
  const { raiseNotification, clearNotification } = useNotifications();

  useEffect(() => {
    if (pending) {
      raiseNotification({ id: NOTIF_ID, message: MESSAGE });
    } else {
      clearNotification(NOTIF_ID);
    }
  }, [pending, raiseNotification, clearNotification]);

  if (!pending) return null;

  return <NotificationBanner tone="amber">{MESSAGE}</NotificationBanner>;
}
