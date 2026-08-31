/**
 * SettingsButton , the gear pinned to the board's bottom-right corner. Renders
 * the full-page Settings overlay behind the always-on PIN gate: gear tap →
 * PinGateModal → success → SettingsPage.
 *
 * Open-state lives in settings-overlay-store (so a board tile , Frontend Logs ,
 * can deep-link Settings onto a page without a prop path); the gate is the
 * shared panel-session Unlock, so if the session is already unlocked Settings
 * opens straight through with no second PIN. The full-screen overlays launched
 * from inside Settings (level, clean screen) are hosted here rather than in
 * SettingsPage: both close the page behind them while open, so exiting one
 * re-opens Settings rather than dumping you on the board.
 */

import { useEffect, useState } from "react";
import { panelSession } from "../lib/panel-session";
import { closeSettings, openSettings, useSettingsOverlay } from "../lib/settings-overlay-store";
import { CleanScreenOverlay } from "./CleanScreenOverlay";
import { ConfettiCelebration } from "./ConfettiCelebration";
import { Icon } from "./Icon";
import { LevelOverlay } from "./LevelOverlay";
import { PinGateModal } from "./pin/PinGateModal";
import { SettingsPage } from "./settings-page/SettingsPage";

export function SettingsButton() {
  // Whether Settings is up and which page to land on (a plain gear tap lands on
  // Device; a deep link , e.g. Frontend Logs → Logs , carries its page).
  const { open, page } = useSettingsOverlay();
  // The shared session Unlock gates the page , one PIN for the whole session.
  const unlocked = panelSession.useIsUnlocked();
  // Full-screen overlays launched from the page. Hosted here, not inside
  // SettingsPage: they close the page behind them, and re-open it on exit.
  const [levelOpen, setLevelOpen] = useState(false);
  const [cleanOpen, setCleanOpen] = useState(false);
  const [celebrating, setCelebrating] = useState(false);

  // Session end must drop the overlay TARGET too, not just the mounted page.
  // While a sub-overlay (level/clean) is up the SettingsPage is unmounted, so
  // the end fan-out's dismissAllModals only closes the sub-overlay — with
  // `open` left true and the unlock dropped, the next render would mount the
  // PIN gate over a dimmed board (decision-1 violation, final-review I-1).
  useEffect(
    () =>
      panelSession.onSessionEnd(() => {
        closeSettings();
        setLevelOpen(false);
        setCleanOpen(false);
        setCelebrating(false);
      }),
    [],
  );

  // Gate shows while Settings is requested but the session is locked; the page
  // shows once unlocked and no sub-overlay is up (those close it behind them).
  const needsGate = open && !unlocked;
  const pageOpen = open && unlocked && !levelOpen && !cleanOpen;

  return (
    <>
      <button
        type="button"
        aria-label="Settings"
        onClick={() => openSettings()}
        style={{
          position: "absolute",
          bottom: 16,
          right: 16,
          // The overlay layer is pointer-events:none; opt this control back in.
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          // 48px clears Apple's 44px minimum touch target , easy to tap on the
          // wall panel without zooming in on the little gear.
          width: 48,
          height: 48,
          padding: 0,
          background: "rgba(12, 14, 17, 0.92)",
          border: "1px solid var(--hair-2)",
          borderRadius: 10,
          color: "var(--ink-2)",
          cursor: "pointer",
        }}
      >
        <Icon name="settings" s={22} />
      </button>
      <PinGateModal
        open={needsGate}
        title="Settings"
        onClose={closeSettings}
        onSuccess={() => panelSession.unlock()}
      />
      <SettingsPage
        open={pageOpen}
        initialPage={page ?? undefined}
        onClose={closeSettings}
        onOpenLevel={() => setLevelOpen(true)}
        onOpenClean={() => setCleanOpen(true)}
      />
      <LevelOverlay open={levelOpen} onClose={() => setLevelOpen(false)} />
      <CleanScreenOverlay
        open={cleanOpen}
        onComplete={() => {
          setCleanOpen(false);
          setCelebrating(true);
        }}
        onCancel={() => setCleanOpen(false)}
      />
      {celebrating ? <ConfettiCelebration onFinished={() => setCelebrating(false)} /> : null}
    </>
  );
}
