/**
 * PinGateModal , the generic soft-lock gate shown before a PIN-gated surface
 * opens (Settings, PIN-gated tile detail pages , the caller supplies the title).
 * The overlay itself (portal, backdrop, Escape, modal registration, open/close
 * logging) is PinModalShell; this file is only the gate's own state machine.
 *
 * The gate is frontend-only , it compares the full 6-digit entry against the
 * synced `pinCode` setting and never sends the digits anywhere. A correct entry
 * flips to an "Unlocked" state and, after a short beat, calls `onSuccess`.
 *
 * NEVER log the entered digits: the interaction channel records only the
 * open/close of the gate, keyed by its title, exactly like ui/Modal.
 */

import { useEffect, useRef, useState } from "react";
import { PIN_LENGTH, useSettings } from "../../lib/settings";
import { Icon } from "../Icon";
import { PinModalCancel, PinModalHeader, PinModalShell } from "./PinModalShell";
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

  // Once unlocked, hand off to onSuccess after a short beat. Cleared on unmount
  // (or if the gate is re-opened) so a late timer never fires post-close.
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  useEffect(() => {
    if (!unlocked) return;
    const t = setTimeout(() => onSuccessRef.current(), UNLOCK_HANDOFF_MS);
    return () => clearTimeout(t);
  }, [unlocked]);

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

  return (
    <PinModalShell
      open={open}
      logTitle={title}
      backdropTestId="pin-gate-backdrop"
      onClose={onClose}
    >
      <PinModalHeader
        icon={<Icon name={unlocked ? "unlock" : "lock"} s={22} />}
        title={unlocked ? "Unlocked" : "Enter PIN"}
        sub={
          unlocked
            ? `Opening ${title}…`
            : error
              ? "Wrong PIN, try again"
              : "Enter your PIN to continue"
        }
        error={error}
        good={unlocked}
      />
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
      <PinModalCancel onClick={onClose} />
    </PinModalShell>
  );
}
