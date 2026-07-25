/**
 * Pure translation rules for the banner → notification-center bridge.
 *
 * The board's two ephemeral banners (ConnectionLostBanner, AppUpdateBanner)
 * raise into the in-memory store in lib/useNotifications.ts. That store is
 * deliberately NOT the notification center: it is live board state ("is this
 * banner on screen right now"), it has no history, and it must keep working
 * with the API down , it is the only thing that can tell you the API is down.
 * DeviceNameBanner does NOT raise into that store (ticket #63): it is a
 * one-time setup nag, not a repeating alert worth a persistent history row, so
 * it has no entry in ALERT_SPECS below and stays a pure presentational read.
 *
 * This module holds the rules for turning one of those live entries into a
 * persistent `notifications.raise` payload. It is pure so the mapping (and
 * especially the connection-outage special case) is unit-testable without React
 * or a tRPC provider; the component that applies it is
 * components/NotificationBridge.tsx.
 */

import type { NotificationCategory, NotificationSeverity } from "./notifications";
import type { Notification as LiveAlert } from "./useNotifications";

/** The in-memory id of the connection banner , the one that gets special care. */
export const CONNECTION_ALERT_ID = "connection-lost";

/** How each known banner id maps into the center's category/severity vocabulary. */
const ALERT_SPECS: Record<
  string,
  { category: NotificationCategory; severity: NotificationSeverity }
> = {
  "app-update": { category: "system", severity: "info" },
  "battery-not-charging": { category: "system", severity: "critical" },
  [CONNECTION_ALERT_ID]: { category: "system", severity: "critical" },
};

/** A `notifications.raise` payload, as the bridge produces it. */
export interface RaisePayload {
  dedupeKey: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  body?: string;
}

/**
 * Translate one live banner entry into a persistent row, or null when the entry
 * has no mapping (an unknown id , new banners opt in by adding a spec above).
 *
 * The dedupe key folds in the MESSAGE, not just the id: the update banner's copy
 * changes as new builds ship ("2 builds behind" → "3 builds behind"), and each
 * of those is genuinely a new thing to tell the user, while a remount with
 * identical copy is not.
 *
 * Returns null for the connection alert: see `outageAlert` , that one cannot be
 * raised at the moment it fires, because the API it would be raised to is by
 * definition unreachable.
 */
export function alertToRaise(alert: LiveAlert): RaisePayload | null {
  if (alert.id === CONNECTION_ALERT_ID) return null;
  const spec = ALERT_SPECS[alert.id];
  if (!spec) return null;
  return {
    dedupeKey: `${alert.id}:${alert.message}`,
    category: spec.category,
    severity: spec.severity,
    title: alert.message,
    body: alert.detail,
  };
}

/**
 * The row recorded for a connection outage, written when the API comes BACK.
 *
 * The connection banner fires precisely when the API is unreachable, so raising
 * a row at that moment is guaranteed to fail (and would sit in React Query's
 * retry path making the outage marginally worse). Recording it on recovery is
 * both possible and more useful: the row can state how long the outage lasted,
 * which is the thing a person reading history actually wants.
 *
 * `startedAtMs` keys the row, so one outage yields one row no matter how many
 * times the banner flickered on the way back up.
 */
export function outageAlert(startedAtMs: number, endedAtMs: number): RaisePayload {
  const seconds = Math.max(1, Math.round((endedAtMs - startedAtMs) / 1000));
  const duration =
    seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return {
    dedupeKey: `${CONNECTION_ALERT_ID}:${startedAtMs}`,
    category: "system",
    severity: "warning",
    title: "Panel lost contact with the API",
    body: `Connection was down for ${duration}, and has recovered.`,
  };
}

/**
 * A stable string identity for the live alert list. Used as an effect dependency
 * so the bridge re-evaluates when the alerts genuinely change, rather than on
 * every render (the store hands back a fresh array identity on each raise).
 */
export function alertsSignature(alerts: readonly LiveAlert[]): string {
  return alerts.map((a) => `${a.id}|${a.message}|${a.detail ?? ""}`).join("\n");
}
