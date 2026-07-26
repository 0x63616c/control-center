/**
 * PROTOTYPE ONLY (#64) — not wired up.
 *
 * Today the board renders three independent, separately-toggled floating
 * labels when their Debug-page switches are on: an FPS readout pinned
 * top-right, and a build-hash / build-number pair stacked bottom-left
 * (apps/web/src/components/Board.tsx FpsMeter / BuildHashBadge /
 * BuildNumberBadge). There's no single place that answers "what is this
 * panel running and is it healthy" at a glance.
 *
 * This is one consolidated card, pinned bottom-right, built from the same
 * `Stat` primitive the tiles use, driven by ONE "Developer overlay" toggle
 * (see DeviceMergedPageView) instead of three. Beyond FPS + build (which
 * already exist), it adds two diagnostics that would answer Calum's "what
 * else could be useful as an overlay" question: live tRPC connection status
 * (StatusDot, same primitive the Network tile uses) and the stable device ID
 * (useful for cross-referencing a panel against `frontend_log` rows without
 * opening Settings).
 */

import { Stat } from "../../../ui/Stat";
import { StatusDot } from "../../../ui/StatusDot";

export interface DevOverlayHudViewProps {
  fps: number;
  webBuild: string;
  connected: boolean;
  deviceId: string;
}

export function DevOverlayHudView({ fps, webBuild, connected, deviceId }: DevOverlayHudViewProps) {
  return (
    <div
      style={{
        position: "absolute",
        bottom: 16,
        right: 16,
        display: "flex",
        gap: 20,
        padding: "12px 16px",
        background: "var(--tile)",
        border: "1px solid var(--hair)",
        borderRadius: 14,
        boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
      }}
    >
      <Stat label="FPS" value={fps} />
      <Stat label="Build" value={webBuild} />
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span className="cap">Link</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <StatusDot online={connected} />
          {connected ? "Connected" : "Offline"}
        </span>
      </div>
      <Stat label="Device" value={deviceId} />
    </div>
  );
}
