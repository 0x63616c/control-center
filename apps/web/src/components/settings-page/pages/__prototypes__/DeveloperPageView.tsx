/**
 * PROTOTYPE ONLY (#64) — not wired up, not registered in PAGE_COMPONENTS.
 *
 * Option B for the settings cleanup: instead of folding Debug entirely into
 * Device (Option A), keep a dedicated "Developer" page but expand it beyond
 * the three overlay toggles into an actual diagnostics surface — the shipped
 * DebugPage today only has switches, no readouts, so there's nowhere in
 * Settings that answers "is this panel healthy right now" without opening the
 * board and looking at the corner badges. About's build/device rows still
 * move to Device (that half of the merge is not in question either option),
 * but Debug survives and grows rather than disappearing.
 *
 * Answers Calum's "what else could be useful as an overlay" with three
 * concrete additions beyond FPS: tRPC connection status, worker heartbeat
 * lag (from integration_sync_status), and a log-level quick filter — the
 * three things worth knowing at a glance without pulling up frontend_log.
 */

import { Segmented } from "../../../ui/Segmented";
import { StatusDot } from "../../../ui/StatusDot";
import { Switch } from "../../../ui/Switch";
import { ActionButton, RowShell, SectionCard } from "../../blocks";

const VALUE_TEXT = { fontFamily: "var(--mono)", fontSize: 14, color: "var(--ink)" } as const;

export interface DeveloperPageViewProps {
  showFps: boolean;
  showBuildBadge: boolean;
  showBuildNumber: boolean;
  onToggleFps: (on: boolean) => void;
  onToggleBuildBadge: (on: boolean) => void;
  onToggleBuildNumber: (on: boolean) => void;
  connected: boolean;
  workerLagLabel: string;
  logLevel: "warn+error" | "all";
  onLogLevelChange: (level: "warn+error" | "all") => void;
}

export function DeveloperPageView({
  showFps,
  showBuildBadge,
  showBuildNumber,
  onToggleFps,
  onToggleBuildBadge,
  onToggleBuildNumber,
  connected,
  workerLagLabel,
  logLevel,
  onLogLevelChange,
}: DeveloperPageViewProps) {
  return (
    <>
      <SectionCard title="Overlays">
        {[
          <RowShell
            key="fps"
            label="FPS meter"
            sub="Show a live frame-rate readout on the board."
            control={<Switch label="FPS meter" checked={showFps} onChange={onToggleFps} />}
          />,
          <RowShell
            key="badge"
            label="Build badge"
            sub="Show the running git SHA in the corner."
            control={
              <Switch label="Build badge" checked={showBuildBadge} onChange={onToggleBuildBadge} />
            }
          />,
          <RowShell
            key="buildnum"
            label="Build number"
            sub="Show the App Store build number in the corner."
            control={
              <Switch
                label="Build number"
                checked={showBuildNumber}
                onChange={onToggleBuildNumber}
              />
            }
          />,
        ]}
      </SectionCard>

      {/* New (#64): live diagnostics, not just toggles — the shipped Debug page
          today has no readouts at all. */}
      <SectionCard title="Live diagnostics">
        {[
          <RowShell
            key="link"
            label="API connection"
            sub="Live tRPC link status."
            control={
              <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <StatusDot online={connected} />
                {connected ? "Connected" : "Offline"}
              </span>
            }
          />,
          <RowShell
            key="worker"
            label="Worker heartbeat"
            sub="Last reconciliation cycle age, across all workers."
            control={<span style={VALUE_TEXT}>{workerLagLabel}</span>}
          />,
          <RowShell
            key="loglevel"
            label="Log capture level"
            sub="Filters what this panel ships to frontend_log."
            stack
            control={
              <Segmented
                label="Log capture level"
                value={logLevel}
                onChange={onLogLevelChange}
                options={[
                  { value: "warn+error", label: "Warn + error" },
                  { value: "all", label: "All" },
                ]}
              />
            }
          />,
        ]}
      </SectionCard>

      <SectionCard title="Diagnostics">
        {[
          <RowShell
            key="reset"
            label="Reset settings"
            sub="Restore every setting on this panel to its default."
            control={<ActionButton onClick={() => {}}>Reset</ActionButton>}
          />,
        ]}
      </SectionCard>
    </>
  );
}
