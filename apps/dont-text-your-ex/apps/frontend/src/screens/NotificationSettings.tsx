import { useEffect, useState } from "react";
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationPreferences,
} from "../../../../contracts";
import { api } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { Toggle } from "../bits";
import { getNativeAppInfo } from "../native/appInfo";
import { disableCurrentPush, enablePush } from "../native/push";
import { T } from "../theme";
import { Screen, TopBar } from "../ui";

export interface NotificationSettingsServices {
  preferences: typeof api.notificationPreferences;
  updatePreferences: typeof api.updateNotificationPreferences;
  enable: () => Promise<{ ok: boolean; reason?: string }>;
  disable: () => Promise<void>;
}

const DEFAULT_SERVICES: NotificationSettingsServices = {
  preferences: api.notificationPreferences,
  updatePreferences: api.updateNotificationPreferences,
  enable: () =>
    enablePush(api.registerPushDevice, async () => {
      const info = await getNativeAppInfo();
      if (!info) throw new Error("native app info unavailable");
      return info;
    }),
  disable: () => disableCurrentPush(api.disablePushDevice),
};

export function NotificationSettings({
  ctx,
  services = DEFAULT_SERVICES,
}: {
  ctx: AppCtx<RouteFor<"notificationSettings">>;
  services?: NotificationSettingsServices;
}) {
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [pushState, setPushState] = useState<"idle" | "enabling" | "enabled" | "denied" | "error">(
    "idle",
  );

  useEffect(() => {
    let alive = true;
    services
      .preferences()
      .then((value) => alive && setPreferences(value))
      .catch(() => alive && setPushState("error"));
    return () => {
      alive = false;
    };
  }, [services]);

  const setCategory = async (category: NotificationCategory, enabled: boolean) => {
    if (!preferences) return;
    const previous = preferences;
    setPreferences({ ...preferences, [category]: enabled });
    try {
      setPreferences(await services.updatePreferences({ [category]: enabled }));
    } catch {
      setPreferences(previous);
    }
  };

  const turnOn = async () => {
    setPushState("enabling");
    try {
      const result = await services.enable();
      setPushState(result.ok ? "enabled" : result.reason === "denied" ? "denied" : "error");
    } catch {
      setPushState("error");
    }
  };

  return (
    <Screen>
      <TopBar onBack={() => ctx.back()} title="Notifications" />
      <div
        style={{
          border: `1px solid ${T.hair}`,
          background: T.surface,
          borderRadius: 18,
          padding: 16,
          marginBottom: 22,
        }}
      >
        <div style={{ fontFamily: T.disp, fontSize: 18, fontWeight: 800 }}>Private by design</div>
        <p style={{ color: T.sec, fontSize: 13.5, lineHeight: 1.45, margin: "6px 0 14px" }}>
          Lock-screen alerts say only that you have an update. Details appear after you open the
          app.
        </p>
        <button
          type="button"
          onClick={turnOn}
          disabled={pushState === "enabling" || pushState === "enabled"}
          style={{
            width: "100%",
            minHeight: 48,
            border: 0,
            borderRadius: 14,
            background: T.gold,
            color: "#000",
            fontFamily: T.disp,
            fontWeight: 800,
          }}
        >
          {pushState === "enabling"
            ? "Turning on…"
            : pushState === "enabled"
              ? "Notifications are on"
              : "Turn on notifications"}
        </button>
        {(pushState === "denied" || pushState === "error") && (
          <p role="alert" style={{ color: T.red, fontSize: 13, margin: "10px 0 0" }}>
            {pushState === "denied"
              ? "Notifications are blocked in iOS Settings."
              : "Notifications couldn’t be enabled. Try again."}
          </p>
        )}
      </div>

      <div style={{ color: T.sec, fontSize: 12, fontWeight: 700, margin: "0 4px 10px" }}>
        WHAT TO SEND
      </div>
      <div style={{ border: `1px solid ${T.hair}`, borderRadius: 18, overflow: "hidden" }}>
        {Object.entries(NOTIFICATION_CATEGORIES)
          .filter(([, definition]) => definition.configurable)
          .map(([key, definition], index) => {
            const category = key as NotificationCategory;
            return (
              <div
                key={category}
                style={{
                  display: "flex",
                  alignItems: "center",
                  minHeight: 58,
                  padding: "0 16px",
                  background: T.surface,
                  borderTop: index ? `1px solid ${T.hair2}` : undefined,
                }}
              >
                <span style={{ flex: 1, fontSize: 15 }}>{definition.label}</span>
                <Toggle
                  label={definition.label}
                  on={preferences?.[category] ?? definition.defaultEnabled}
                  onChange={(enabled) => void setCategory(category, enabled)}
                />
              </div>
            );
          })}
      </div>
      <button
        type="button"
        onClick={() =>
          void services.disable().then(
            () => setPushState("idle"),
            () => undefined,
          )
        }
        style={{
          width: "100%",
          marginTop: 20,
          minHeight: 48,
          border: `1px solid ${T.hair}`,
          borderRadius: 14,
          background: T.surface2,
          color: T.red,
        }}
      >
        Turn off on this device
      </button>
    </Screen>
  );
}
