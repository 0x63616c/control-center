/**
 * Device settings page , identity (editable name), live status readouts
 * (battery, mount tilt, stable device id), build provenance, and developer
 * tools. Wires the shared settings/sensor stores into the Concept-A section
 * cards exactly like the old SettingsPanel's Device section; carries no local
 * state of its own beyond the camera probe and the reset confirmation.
 *
 * #64: folds the former Debug and About pages in here , build/version info
 * lives where you'd look for "what is this panel" instead of a separate
 * pair of pages, and Debug's three overlay switches (with no readouts) sat
 * next to About's readouts (with no switches), which was the exact sprawl
 * this merge removes. The Build section (web/server/app build SHA + age)
 * moved from AboutPage.tsx verbatim; the Developer section replaces Debug's
 * three separate switches with one ("Developer overlay", see
 * useDeveloperOverlay/setDeveloperOverlay in lib/settings.ts and
 * DevOverlayHud.tsx); Reset moved from Debug's "Diagnostics" section into a
 * low-emphasis Danger zone at the bottom.
 */

import { useCallback, useEffect, useState } from "react";
import { BUILD_HASH, BUILD_TIME } from "../../../config/build";
import { getInstalledBuildNumber } from "../../../lib/app-update";
import { getDeviceId } from "../../../lib/device-id";
import { deriveDefaultName, setDeviceName, useDeviceName } from "../../../lib/device-name";
import { formatRelativeAge } from "../../../lib/relative-age";
import { resetSettings, setDeveloperOverlay, useDeveloperOverlay } from "../../../lib/settings";
import { formatSha } from "../../../lib/short-sha";
import { formatTilt } from "../../../lib/tilt";
import { trpc } from "../../../lib/trpc";
import { formatBattery, useBatteryInfo } from "../../../lib/useBatteryInfo";
import { useTiltAngle } from "../../../lib/useTiltAngle";
import {
  type CameraPermissionState,
  type CameraProbeResult,
  cameraPermissionState,
  probeCamera,
} from "../../../lib/wake-capture";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Skeleton } from "../../ui/Skeleton";
import { Switch } from "../../ui/Switch";
import { TextInput } from "../../ui/TextInput";
import { ActionButton, ChevronValue, RowShell, SectionCard } from "../blocks";
import type { PageProps } from "../SettingsPage";

const VALUE_TEXT = { fontFamily: "var(--mono)", fontSize: 14, color: "var(--ink)" } as const;

/**
 * Human label for the OS camera permission. Same shape as the notifications
 * page's push-permission row: the value lives outside React (TCC prompt, iOS
 * Settings), so the page shows what the OS reports, not what the app hopes.
 */
const CAMERA_PERMISSION_LABEL: Record<CameraPermissionState, string> = {
  granted: "Granted",
  denied: "Denied , enable in iOS Settings > Control Center > Camera",
  prompt: "Not yet requested",
  unknown: "Unknown , this WebKit can't report it; use Test camera",
};

/** "<sha> · <age>" when an age is available, else just the SHA. Moved from
 *  AboutPage.tsx verbatim (#64). */
function shaWithAge(hash: string, builtAtMs: number, nowMs: number): string {
  const age = formatRelativeAge(builtAtMs, nowMs);
  return age ? `${formatSha(hash)} · ${age}` : formatSha(hash);
}

export function DevicePage({ onOpenLevel }: PageProps) {
  const { name: deviceName, isSet: deviceNameSet } = useDeviceName();
  // The page only mounts while Settings is open, so both sensors run exactly
  // for that lifetime.
  const battery = useBatteryInfo(true);
  const tilt = useTiltAngle(true);

  const [cameraPermission, setCameraPermission] = useState<CameraPermissionState | null>(null);
  const [probe, setProbe] = useState<CameraProbeResult | "running" | null>(null);

  // Folded in from About (#64): build provenance.
  const server = trpc.health.buildHash.useQuery();
  // Native CFBundleVersion resolves asynchronously and only on the device; a
  // plain browser (dev/Storybook) yields null, shown as "n/a".
  const [appBuild, setAppBuild] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void getInstalledBuildNumber().then((n) => {
      if (live) setAppBuild(n);
    });
    return () => {
      live = false;
    };
  }, []);
  // A single "now" captured at render is fine for a coarse age readout that
  // only needs minute/hour/day granularity.
  const now = Date.now();

  // Folded in from Debug (#64): the developer overlay toggle + guarded reset.
  const developerOverlay = useDeveloperOverlay();
  const [confirmReset, setConfirmReset] = useState(false);

  // Re-read on mount and after every probe , the OS state changes outside
  // React (the TCC prompt, or a Settings toggle while the app is backgrounded).
  const refreshCameraPermission = useCallback(() => {
    void cameraPermissionState().then(setCameraPermission);
  }, []);

  useEffect(() => {
    refreshCameraPermission();
  }, [refreshCameraPermission]);

  const onTestCamera = useCallback(() => {
    // Re-entrancy guard in the handler (ActionButton has no disabled state):
    // a second tap mid-probe must not open a second camera stream.
    if (probe === "running") return;
    setProbe("running");
    void probeCamera().then((result) => {
      setProbe(result);
      refreshCameraPermission();
    });
  }, [probe, refreshCameraPermission]);

  const probeSub =
    probe === null
      ? "Opens the front camera once and releases it , raises the permission prompt if it was never asked."
      : probe === "running"
        ? "Opening camera…"
        : probe.ok
          ? "Camera opened. Wake photos should work."
          : `${probe.name}: ${probe.message}`;

  return (
    <>
      <SectionCard title="Identity">
        {[
          // Value shows the user's chosen name (empty until they set one, so the
          // placeholder reveals the auto-derived default); clearing it reverts to
          // that default and re-raises the "set your device name" banner.
          <TextInput
            key="name"
            label="Device name"
            value={deviceNameSet ? deviceName : ""}
            placeholder={deriveDefaultName()}
            onChange={setDeviceName}
          />,
        ]}
      </SectionCard>

      <SectionCard title="Status">
        {[
          <RowShell
            key="battery"
            label="Battery"
            sub="Charge state of this panel."
            control={
              battery ? (
                <span
                  style={{
                    ...VALUE_TEXT,
                    color: battery.isCharging ? "var(--green, #7ac48f)" : "var(--ink)",
                  }}
                >
                  {formatBattery(battery)}
                </span>
              ) : (
                <span style={VALUE_TEXT}>unavailable</span>
              )
            }
          />,
          <RowShell
            key="level"
            label="Level"
            sub="Open the full screen level to adjust the mount."
            control={
              <ChevronValue
                value={tilt.state === "ready" ? formatTilt(tilt.angle) : "--"}
                onClick={onOpenLevel}
              />
            }
          />,
          <RowShell
            key="id"
            label="Device ID"
            sub="Stable identity used to tag this panel's logs."
            control={<span style={VALUE_TEXT}>{getDeviceId()}</span>}
          />,
        ]}
      </SectionCard>

      <SectionCard title="Wake camera">
        {[
          <RowShell
            key="permission"
            label="OS permission"
            control={
              <span style={VALUE_TEXT}>
                {cameraPermission ? CAMERA_PERMISSION_LABEL[cameraPermission] : "Checking…"}
              </span>
            }
          />,
          <RowShell
            key="test"
            label="Test camera"
            sub={probeSub}
            control={<ActionButton onClick={onTestCamera}>Test</ActionButton>}
          />,
        ]}
      </SectionCard>

      {/* Folded in from About (#64): build provenance lives with device
          identity now, instead of a separate page. */}
      <SectionCard title="Build">
        {[
          <RowShell
            key="web"
            label="Web"
            sub="The panel bundle currently running."
            control={<span style={VALUE_TEXT}>{shaWithAge(BUILD_HASH, BUILD_TIME, now)}</span>}
          />,
          <RowShell
            key="server"
            label="Server"
            sub="The control-center API build serving this panel."
            control={
              server.isLoading ? (
                <Skeleton w={120} />
              ) : server.data ? (
                <span style={VALUE_TEXT}>
                  {shaWithAge(server.data.hash, Date.parse(server.data.deployedAt), now)}
                </span>
              ) : (
                <span style={{ ...VALUE_TEXT, color: "var(--ink-3)" }}>unavailable</span>
              )
            }
          />,
          <RowShell
            key="app"
            label="App build"
            sub="The native TestFlight build installed on this device."
            control={<span style={VALUE_TEXT}>{appBuild === null ? "n/a" : appBuild}</span>}
          />,
          <RowShell
            key="screen"
            label="Screen"
            sub="Fixed wall-panel resolution."
            control={<span style={VALUE_TEXT}>1366×1024</span>}
          />,
        ]}
      </SectionCard>

      {/* Folded in from Debug (#64): one "Developer overlay" switch replaces
          the three separate FPS/build-badge/build-number switches, driving a
          single consolidated HUD on the board (see DevOverlayHud.tsx). */}
      <SectionCard title="Developer">
        {[
          <RowShell
            key="overlay"
            label="Developer overlay"
            sub="Show a live diagnostics HUD on the board: FPS, build, connection, device ID."
            control={
              <Switch
                label="Developer overlay"
                checked={developerOverlay}
                onChange={setDeveloperOverlay}
              />
            }
          />,
        ]}
      </SectionCard>

      {/* Moved from Debug's "Diagnostics" section (#64): a destructive,
          rarely-used action gets its own low-emphasis zone at the bottom
          rather than sitting beside the overlay switches. */}
      <SectionCard title="Danger zone">
        {[
          <RowShell
            key="reset"
            label="Reset settings"
            sub="Restore every setting on this panel to its default."
            control={<ActionButton onClick={() => setConfirmReset(true)}>Reset</ActionButton>}
          />,
        ]}
      </SectionCard>

      <ConfirmDialog
        open={confirmReset}
        title="Reset settings?"
        message="Restore every setting on this panel to its default. This cannot be undone."
        confirmLabel="Reset"
        tone="danger"
        onConfirm={() => {
          resetSettings();
          setConfirmReset(false);
        }}
        onClose={() => setConfirmReset(false)}
      />
    </>
  );
}
