/**
 * PinGateModal , the generic soft-lock gate shown before a PIN-gated surface
 * opens (Settings, PIN-gated tile detail pages , the caller supplies the title).
 * A body-portal overlay (same structure as ui/Modal) with the approved
 * PinUnlockModalConcept dialog inside: lock chip, title, the tap pad, Cancel.
 *
 * The gate is frontend-only , it compares the full 6-digit entry against the
 * synced `pinCode` setting and never sends the digits anywhere. A correct entry
 * flips to an "Unlocked" state and, after a short beat, calls `onSuccess`.
 *
 * NEVER log the entered digits: the interaction channel records only the
 * open/close of the gate, keyed by its title, exactly like ui/Modal.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { interaction } from "../../lib/log/interaction";
import { registerOpenModal } from "../../lib/modal-open-store";
import { PIN_LENGTH, useSettings } from "../../lib/settings";
import { Icon } from "../Icon";
import { PinPadView } from "./PinPad";

// Beat between the unlocked state showing and handing off to onSuccess, so the
// person sees the gate open rather than it vanishing mid-tap.
const UNLOCK_HANDOFF_MS = 250;

export function PinGateModal({
  open,
  title,
  onClose,
  onSuccess,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { pinCode, pinPadLayout } = useSettings();
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  // Bumped after every rejected entry so a moving pad redraws between attempts ,
  // reusing the layout across retries would hand a shoulder-surfer the same
  // positional trace twice.
  const [attempt, setAttempt] = useState(0);

  // Reset all internal state whenever the gate is (re)opened or closed so a
  // second open never inherits the last attempt's dots/error/unlocked flags.
  // `open` is the intended trigger even though the body only calls setters.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on open flip
  useEffect(() => {
    setPin("");
    setError(false);
    setUnlocked(false);
    setAttempt(0);
  }, [open]);

  // Register in the global modal-open count while open (freezes board pan, lets
  // idle-reset dismiss us). Routed through a ref so a fresh onClose each render
  // never re-registers , copied from ui/Modal.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    return registerOpenModal(() => onCloseRef.current());
  }, [open]);

  // Interaction log: open/close of the gate only , never the digits. Keyed by
  // title (`modal.pin.Settings`) so the two gates are distinguishable. Title via
  // ref so a changing title doesn't fabricate a close/open pair.
  const titleRef = useRef(title);
  titleRef.current = title;
  useEffect(() => {
    if (!open) return;
    const target = `modal.pin.${titleRef.current}`;
    interaction("modal", "open", target);
    return () => interaction("modal", "close", target);
  }, [open]);

  // Escape-to-close, attached only while open.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Once unlocked, hand off to onSuccess after a short beat. Cleared on unmount
  // (or if the gate is re-opened) so a late timer never fires post-close.
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  useEffect(() => {
    if (!unlocked) return;
    const t = setTimeout(() => onSuccessRef.current(), UNLOCK_HANDOFF_MS);
    return () => clearTimeout(t);
  }, [unlocked]);

  if (!open) return null;

  function digit(d: string) {
    if (unlocked) return;
    setError(false);
    const next = pin + d;
    if (next.length < PIN_LENGTH) {
      setPin(next);
      return;
    }
    // Full length: check against the synced PIN.
    if (next === pinCode) {
      setPin(next);
      setUnlocked(true);
    } else {
      setPin("");
      setError(true);
      setAttempt((n) => n + 1);
    }
  }

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Backdrop: a button so click-to-dismiss is genuinely interactive and
          focusable. aria-hidden + tabIndex -1 keep it out of the tab/AT order;
          Escape and the visible Cancel button are the announced affordances. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        data-testid="pin-gate-backdrop"
        className="modal-backdrop"
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          border: "none",
          padding: 0,
          cursor: "default",
          background: "rgba(0, 0, 0, 0.55)",
        }}
      />

      {/* Centered card , the approved PinUnlockModalConcept dialog. */}
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: "relative",
          background: "var(--tile)",
          border: "1px solid var(--hair)",
          borderRadius: "var(--r)",
          boxShadow: "0 24px 64px -16px rgba(0, 0, 0, 0.7)",
          width: 720,
          padding: "48px 40px 44px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 24,
          color: "var(--ink)",
          fontFamily: "var(--ui)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: "var(--nest)",
              border: "1px solid var(--hair)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: unlocked ? "#43a56c" : "var(--ink-2)",
              marginBottom: 6,
            }}
          >
            <Icon name={unlocked ? "unlock" : "lock"} s={22} />
          </div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{unlocked ? "Unlocked" : "Enter PIN"}</div>
          <div style={{ fontSize: 13, color: error ? "#c95c5c" : "var(--ink-3)" }}>
            {unlocked
              ? `Opening ${title}…`
              : error
                ? "Wrong PIN, try again"
                : "Enter your PIN to continue"}
          </div>
        </div>
        <PinPadView
          entered={pin.length}
          error={error}
          layout={pinPadLayout}
          shuffleKey={attempt}
          onDigit={digit}
          onBackspace={() => {
            setError(false);
            setPin((p) => p.slice(0, -1));
          }}
        />
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--ink-3)",
            fontFamily: "var(--ui)",
            fontSize: 14,
            cursor: "pointer",
            padding: 4,
          }}
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
}
