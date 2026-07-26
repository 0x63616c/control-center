/**
 * PROTOTYPE ONLY (#64) — not wired up, not registered in PAGE_COMPONENTS.
 *
 * Option A for the settings cleanup: fold Debug's overlay toggles and About's
 * build/device info into the Device page, so build numbers live where you'd
 * look for "what is this panel" instead of a separate Debug/About pair. The
 * three independent corner badges (FPS meter, build hash, build number)
 * collapse into a single "Developer overlay" toggle driving one consolidated
 * HUD (see DevOverlayHudView) instead of three separately-toggled floaters.
 *
 * Purely presentational and prop-driven, mirroring the real DevicePage's
 * markup exactly (same SectionCard/RowShell blocks, same VALUE_TEXT style) so
 * the screenshot is a fair comparison, not a redesign of the visual language.
 */

import { useState } from "react";
import { ConfirmDialog } from "../../../ui/ConfirmDialog";
import { Switch } from "../../../ui/Switch";
import { TextInput } from "../../../ui/TextInput";
import { ActionButton, ChevronValue, RowShell, SectionCard } from "../../blocks";

const VALUE_TEXT = { fontFamily: "var(--mono)", fontSize: 14, color: "var(--ink)" } as const;

export interface DeviceMergedPageViewProps {
  deviceName: string;
  batteryLabel: string;
  tiltLabel: string;
  deviceId: string;
  cameraPermissionLabel: string;
  webBuild: string;
  serverBuild: string;
  appBuild: string;
  developerOverlay: boolean;
  onToggleDeveloperOverlay: (on: boolean) => void;
}

export function DeviceMergedPageView({
  deviceName,
  batteryLabel,
  tiltLabel,
  deviceId,
  cameraPermissionLabel,
  webBuild,
  serverBuild,
  appBuild,
  developerOverlay,
  onToggleDeveloperOverlay,
}: DeviceMergedPageViewProps) {
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <>
      <SectionCard title="Identity">
        {[<TextInput key="name" label="Device name" value={deviceName} onChange={() => {}} />]}
      </SectionCard>

      <SectionCard title="Status">
        {[
          <RowShell
            key="battery"
            label="Battery"
            sub="Charge state of this panel."
            control={<span style={VALUE_TEXT}>{batteryLabel}</span>}
          />,
          <RowShell
            key="level"
            label="Level"
            sub="Open the full screen level to adjust the mount."
            control={<ChevronValue value={tiltLabel} />}
          />,
          <RowShell
            key="id"
            label="Device ID"
            sub="Stable identity used to tag this panel's logs."
            control={<span style={VALUE_TEXT}>{deviceId}</span>}
          />,
        ]}
      </SectionCard>

      <SectionCard title="Wake camera">
        {[
          <RowShell
            key="permission"
            label="OS permission"
            control={<span style={VALUE_TEXT}>{cameraPermissionLabel}</span>}
          />,
          <RowShell
            key="test"
            label="Test camera"
            sub="Opens the front camera once and releases it."
            control={<ActionButton>Test</ActionButton>}
          />,
        ]}
      </SectionCard>

      {/* Folded in from About (#64): build provenance lives with device identity now. */}
      <SectionCard title="Build">
        {[
          <RowShell
            key="web"
            label="Web"
            sub="The panel bundle currently running."
            control={<span style={VALUE_TEXT}>{webBuild}</span>}
          />,
          <RowShell
            key="server"
            label="Server"
            sub="The control-center API build serving this panel."
            control={<span style={VALUE_TEXT}>{serverBuild}</span>}
          />,
          <RowShell
            key="app"
            label="App build"
            sub="The native TestFlight build installed on this device."
            control={<span style={VALUE_TEXT}>{appBuild}</span>}
          />,
        ]}
      </SectionCard>

      {/* Folded in from Debug (#64): one toggle instead of three. */}
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
                onChange={onToggleDeveloperOverlay}
              />
            }
          />,
        ]}
      </SectionCard>

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
        onConfirm={() => setConfirmReset(false)}
        onClose={() => setConfirmReset(false)}
      />
    </>
  );
}
