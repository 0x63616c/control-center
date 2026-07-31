import { createPortal } from "react-dom";
import { useNow } from "../lib/hooks";
import { Z_LAYER } from "../lib/z-layers";

const MAX_BLUR_PX = 20;

/** Converts the synced 0–100% policy to the finite visual blur range. */
export function blurPixelsForPercent(percent: number): number {
  return (Math.min(100, Math.max(0, percent)) / 100) * MAX_BLUR_PX;
}

function formatTime(now: Date): string {
  return now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** A live-glass idle lock: board content keeps rendering behind this portal. */
export function LockScreenOverlay({
  active,
  blurPercent,
  onRequestUnlock,
}: {
  active: boolean;
  blurPercent: number;
  onRequestUnlock: () => void;
}) {
  const now = useNow(60_000);
  if (!active) return null;
  const blur = `blur(${blurPixelsForPercent(blurPercent)}px)`;
  return createPortal(
    <button
      type="button"
      data-testid="lock-screen-overlay"
      aria-label="Unlock panel"
      onPointerDown={(event) => event.preventDefault()}
      onClick={onRequestUnlock}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: Z_LAYER.lockScreen,
        border: "none",
        padding: 0,
        background: "rgba(0, 0, 0, 0.08)",
        color: "var(--ink)",
        cursor: "pointer",
        backdropFilter: blur,
        WebkitBackdropFilter: blur,
        fontFamily: "var(--mono)",
        fontSize: 72,
        fontWeight: 500,
      }}
    >
      {formatTime(now)}
    </button>,
    document.body,
  );
}
