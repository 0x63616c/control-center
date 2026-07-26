/**
 * PROTOTYPE ONLY (#64) — design exploration for "massively clean up the
 * settings page and rethink the dev overlay." Nothing here is wired into the
 * real PAGE_COMPONENTS registry; these stories exist purely so the option can
 * be screenshotted next to the current shipped pages for comparison.
 *
 * See DeviceMergedPageView and DevOverlayHudView for the design rationale.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { DeveloperPageView } from "./DeveloperPageView";
import { DeviceMergedPageView } from "./DeviceMergedPageView";
import { DevOverlayHudView } from "./DevOverlayHudView";

// Same footprint as the real Settings content column (720px on var(--bg)),
// matching apps/web/src/components/settings-page/pages/SettingsPages.stories.tsx's
// ColumnFrame so this reads exactly like the shipped shell.
function ColumnFrame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 40, background: "var(--bg)", minHeight: "100vh" }}>
      <div
        style={{
          width: 720,
          margin: "0 auto",
          color: "var(--ink)",
          fontFamily: "var(--ui)",
          display: "flex",
          flexDirection: "column",
          gap: 28,
        }}
      >
        {children}
      </div>
    </div>
  );
}

// A dark board-like backdrop so the HUD prototype reads the way it would
// pinned over live tile content, not floating on a blank canvas.
function BoardBackdrop({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "relative",
        width: 1366,
        height: 1024,
        background: "var(--bg)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "repeating-linear-gradient(0deg, var(--hair) 0 1px, transparent 1px 64px), repeating-linear-gradient(90deg, var(--hair) 0 1px, transparent 1px 64px)",
          opacity: 0.35,
        }}
      />
      {children}
    </div>
  );
}

const meta = {
  title: "Prototypes/Issue 64 - Settings cleanup",
  tags: ["autodocs"],
  parameters: { boardWrapper: false, layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Option A: Debug's overlay toggles and About's build/device info folded into
 * Device, collapsing the sidebar from 10 pages to 8 (Debug and About removed).
 */
export const OptionA_MergedDevicePage: Story = {
  render: () => {
    function Wrapper() {
      const [overlay, setOverlay] = useState(true);
      return (
        <ColumnFrame>
          <DeviceMergedPageView
            deviceName="Kitchen Panel"
            batteryLabel="87% - not charging"
            tiltLabel="0.4°"
            deviceId="dev_8f2a1c"
            cameraPermissionLabel="Granted"
            webBuild="#a1b2c3d - 2hrs"
            serverBuild="#7e4f102 - 3hrs"
            appBuild="142"
            developerOverlay={overlay}
            onToggleDeveloperOverlay={setOverlay}
          />
        </ColumnFrame>
      );
    }
    return <Wrapper />;
  },
};

/**
 * Option A's replacement for the three independent corner badges: one
 * consolidated HUD card, toggled by the single "Developer overlay" switch
 * above, shown here pinned over a mock board so it reads at the size/position
 * it would on the real 1366x1024 panel.
 */
export const OptionA_ConsolidatedDevOverlay: Story = {
  render: () => (
    <BoardBackdrop>
      <DevOverlayHudView fps={60} webBuild="#a1b2c3d" connected={true} deviceId="dev_8f2a1c" />
    </BoardBackdrop>
  ),
};

/**
 * Option B: keep a dedicated Developer page (don't fold Debug away entirely)
 * but expand it from three switches into a real diagnostics surface — live
 * connection status, worker heartbeat lag, and a log-level quick filter,
 * alongside the existing FPS/build-badge/build-number overlay toggles. About's
 * build/device rows still move to Device either way; this option differs from
 * A only in whether Debug survives as its own page.
 */
export const OptionB_ExpandedDeveloperPage: Story = {
  render: () => {
    function Wrapper() {
      const [showFps, setShowFps] = useState(true);
      const [showBuildBadge, setShowBuildBadge] = useState(false);
      const [showBuildNumber, setShowBuildNumber] = useState(false);
      const [logLevel, setLogLevel] = useState<"warn+error" | "all">("warn+error");
      return (
        <ColumnFrame>
          <DeveloperPageView
            showFps={showFps}
            showBuildBadge={showBuildBadge}
            showBuildNumber={showBuildNumber}
            onToggleFps={setShowFps}
            onToggleBuildBadge={setShowBuildBadge}
            onToggleBuildNumber={setShowBuildNumber}
            connected={true}
            workerLagLabel="0.8s"
            logLevel={logLevel}
            onLogLevelChange={setLogLevel}
          />
        </ColumnFrame>
      );
    }
    return <Wrapper />;
  },
};
