/**
 * Battery readout via @capacitor/device , used by both the settings Device
 * row (`enabled` only while that modal is open) and NotChargingBanner
 * (`enabled` for the panel's whole lifetime).
 *
 * The wall panel sits on dock power, so the interesting signal is "still
 * charging?" rather than a fast-moving percentage , hence a 15s poll rather
 * than something tighter. In a plain browser / Storybook the plugin has no
 * native side and this resolves to null, which callers render as unavailable.
 * Mirrors the dynamic-import pattern in app-update.ts so the Capacitor module
 * stays out of the main bundle path.
 */

import { Capacitor } from "@capacitor/core";
import { useEffect, useState } from "react";

const POLL_MS = 15_000;

export interface BatteryInfo {
  /** 0..1 */
  level: number;
  isCharging: boolean;
}

export function useBatteryInfo(enabled: boolean): BatteryInfo | null {
  const [info, setInfo] = useState<BatteryInfo | null>(null);

  useEffect(() => {
    if (!enabled || !Capacitor.isNativePlatform()) return;

    let cancelled = false;

    async function read() {
      try {
        const { Device } = await import("@capacitor/device");
        const battery = await Device.getBatteryInfo();
        if (cancelled) return;
        // An unreadable value resets to unknown rather than keeping the last
        // good reading: a stale `isCharging: false` left in state from before
        // a plug event would otherwise freeze the not-charging banner on
        // regardless of what the device is actually doing now (#201).
        if (battery.batteryLevel == null || battery.isCharging == null) {
          setInfo(null);
          return;
        }
        setInfo({ level: battery.batteryLevel, isCharging: battery.isCharging });
      } catch {
        // Best-effort , a battery read failure must never break settings.
      }
    }

    void read();
    const timer = setInterval(read, POLL_MS);
    // Re-check immediately when the panel regains focus (e.g. right after the
    // user plugs/unplugs it), so the banner reflects the current state
    // instead of waiting up to a full POLL_MS tick.
    const onVisible = () => {
      if (document.visibilityState === "visible") void read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);

  return info;
}

/** Charge percent only, e.g. "87%" , shared by the row and its tests. The
 *  charging state is conveyed by colour in the Device row, not this string. */
export function formatBattery(info: BatteryInfo): string {
  return `${Math.round(info.level * 100)}%`;
}
