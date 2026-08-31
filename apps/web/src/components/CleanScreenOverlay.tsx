/**
 * CleanScreenOverlay , timers and the hold-to-exit gesture for cleaning mode.
 *
 * Two ways out, both handled here:
 *  - the 3s press-and-hold completing, or
 *  - the 10 minute failsafe expiring (in case wedged touches make the button
 *    unreachable , the panel must never need a power cycle to come back).
 *
 * The countdown ticks on a 250ms interval (display only shows whole seconds;
 * the finer tick keeps the hold fill and expiry snappy without rAF plumbing).
 * Rendered through a body portal so wipes can't reach the pannable stage.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { registerOpenModal } from "../lib/modal-open-store";
import { CleanScreenOverlayView } from "./CleanScreenOverlayView";

export const CLEAN_MODE_DURATION_MS = 10 * 60 * 1000;
export const HOLD_TO_EXIT_MS = 3000;
const TICK_MS = 250;

export interface CleanScreenOverlayProps {
  open: boolean;
  onComplete: () => void;
  onCancel: () => void;
}

export function CleanScreenOverlay({ open, onComplete, onCancel }: CleanScreenOverlayProps) {
  const [now, setNow] = useState(() => Date.now());
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [holdStartedAt, setHoldStartedAt] = useState<number | null>(null);
  const closed = useRef(false);

  // Restart the clocks each time the mode opens.
  useEffect(() => {
    if (!open) return;
    closed.current = false;
    const opened = Date.now();
    setStartedAt(opened);
    setNow(opened);
    setHoldStartedAt(null);
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [open]);

  // Counts as an open modal (freezes the board) but deliberately registers NO
  // dismisser: cleaning mode is exactly the state where the panel should ignore
  // everything for its duration, so the board's idle reset must not close it.
  // It owns its own exit (hold-to-exit, plus the duration failsafe above).
  useEffect(() => {
    if (!open) return;
    return registerOpenModal();
  }, [open]);

  const remainingMs = Math.max(0, CLEAN_MODE_DURATION_MS - (now - startedAt));
  const holdProgress =
    holdStartedAt == null ? 0 : Math.min(1, (now - holdStartedAt) / HOLD_TO_EXIT_MS);

  // A deliberate hold is the only successful completion. The failsafe is a
  // cancellation, so callers cannot mistake automatic recovery for success.
  useEffect(() => {
    if (!open || closed.current) return;
    if (holdProgress >= 1) {
      closed.current = true;
      onComplete();
    } else if (remainingMs <= 0) {
      closed.current = true;
      onCancel();
    }
  }, [open, holdProgress, remainingMs, onComplete, onCancel]);

  if (!open) return null;

  return createPortal(
    <CleanScreenOverlayView
      remainingMs={remainingMs}
      holdProgress={holdProgress}
      onHoldStart={() => {
        setHoldStartedAt(Date.now());
        setNow(Date.now());
      }}
      onHoldEnd={() => setHoldStartedAt(null)}
    />,
    document.body,
  );
}
