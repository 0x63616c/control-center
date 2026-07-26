/**
 * The on-board developer overlay (#64). Replaces three independent,
 * separately-toggled floating labels , FpsMeter (top-right), BuildHashBadge
 * and BuildNumberBadge (stacked bottom-left) , with one consolidated HUD card,
 * built from the same `Stat`/`StatusDot` primitives the tiles use. Gated by
 * the single "Developer overlay" switch on the Device settings page
 * (`useDeveloperOverlay`/`setDeveloperOverlay` in lib/settings.ts), which
 * still drives the three underlying synced fields under the hood.
 *
 * Beyond FPS + build (which already existed as separate badges), this adds
 * two diagnostics worth having at a glance: live tRPC connection status
 * (same source `ConnectionLostBanner` uses) and the stable device ID (useful
 * for cross-referencing a panel against `frontend_log` without opening
 * Settings). The native app build number keeps its own conditional Stat,
 * exactly like the old BuildNumberBadge , it renders nothing off-device.
 *
 * Pinned top-right (FpsMeter's old spot): bottom-right is SettingsButton's
 * corner and bottom-left/top-left are Minimap territory.
 */

import { useEffect, useState } from "react";
import { BUILD_HASH, BUILD_TIME } from "../config/build";
import { getInstalledBuildNumber } from "../lib/app-update";
import { getDeviceId } from "../lib/device-id";
import { formatRelativeAge } from "../lib/relative-age";
import { formatSha } from "../lib/short-sha";
import { useConnectionStatus } from "../lib/useConnectionStatus";
import { FpsSparkline } from "./FpsSparkline";
import { Stat } from "./ui/Stat";
import { StatusDot } from "./ui/StatusDot";

/** Live frame rate + a 60s sparkline history, sampled twice a second (same
 *  cadence the old FpsMeter used). */
function useFps(): { fps: number; samples: number[] } {
  const [fps, setFps] = useState(0);
  const [samples, setSamples] = useState<number[]>([]);
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const loop = (now: number) => {
      frames++;
      if (now - last >= 500) {
        const fpsValue = Math.round((frames * 1000) / (now - last));
        setFps(fpsValue);
        setSamples((s) => [...s, fpsValue].slice(-120));
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return { fps, samples };
}

/** The installed native app build number (CFBundleVersion); null off-device
 *  (plain browser / Storybook), same as the old BuildNumberBadge. */
function useAppBuild(): number | null {
  const [build, setBuild] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getInstalledBuildNumber().then((b) => {
      if (!cancelled) setBuild(b);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return build;
}

export function DevOverlayHud() {
  const { fps, samples } = useFps();
  const appBuild = useAppBuild();
  // useConnectionStatus is the only React Query interaction in this
  // component , pairing it with a live trpc useQuery in the same component
  // has caused a cache-event feedback loop before, so this HUD stays a sole
  // consumer (see ConnectionLostBanner, which does the same split).
  const { isLost } = useConnectionStatus();

  // Age ticks once a minute, same as the old BuildHashBadge.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const age = formatRelativeAge(BUILD_TIME, now);
  const buildLabel = age ? `${formatSha(BUILD_HASH)} ${age}` : formatSha(BUILD_HASH);

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        display: "flex",
        alignItems: "flex-start",
        gap: 20,
        padding: "10px 16px",
        background: "var(--tile)",
        border: "1px solid var(--hair)",
        borderRadius: 14,
        boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Stat label="FPS" value={fps} />
        <FpsSparkline samples={samples} />
      </div>
      <Stat label="Build" value={buildLabel} />
      {appBuild !== null ? <Stat label="App build" value={appBuild} /> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span className="cap">Link</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <StatusDot online={!isLost} />
          {isLost ? "Offline" : "Connected"}
        </span>
      </div>
      <Stat label="Device" value={getDeviceId()} />
    </div>
  );
}
