/**
 * PinChangeModal , the three-stage change-PIN machine (verify the current PIN,
 * enter a new one, confirm it) on its own surface.
 *
 * It used to live inline in a permanently-mounted card on the Security page,
 * which forced a fourth "PIN changed" stage with a *Change again* button: the
 * card had nowhere to dismiss to, so it had to offer something, and what it
 * offered was doing the whole thing over. On its own surface success is simply
 * the flow disappearing (#298) , the caller closes us and confirms on the row.
 *
 * The machine itself is unchanged from the Security page version: each stage is
 * its own PIN entry, so each gets its own pad layout (`shuffleKey={stage}`); a
 * mismatched confirm restarts the new/confirm PAIR rather than the whole flow
 * (re-verifying the current PIN you just proved is busywork); and `setPinCode`
 * fires only on a confirm that matches.
 *
 * NEVER log or persist the entered digits , see PinModalShell's header.
 */

import { useEffect, useState } from "react";
import { PIN_LENGTH, setPinCode, useSettings } from "../../lib/settings";
import { Icon } from "../Icon";
import { PinModalCancel, PinModalHeader, PinModalShell } from "./PinModalShell";
import { PinPadView } from "./PinPad";

type ChangeStage = "current" | "new" | "confirm";

/** The three steps, in order , also the progress indicator's source of truth. */
const STAGES: readonly ChangeStage[] = ["current", "new", "confirm"];

const STAGE_COPY: Record<ChangeStage, { title: string; sub: string }> = {
  current: { title: "Enter current PIN", sub: "Confirm it's you before changing the PIN." },
  new: { title: "Enter new PIN", sub: "Six digits. Used by every panel." },
  confirm: { title: "Confirm new PIN", sub: "Type the new PIN once more." },
};

export function PinChangeModal({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  /** A matching confirm , the PIN is already saved by the time this fires. The
   *  caller dismisses us and shows the confirmation on the row. */
  onChanged: () => void;
}) {
  const { pinCode, pinPadLayout } = useSettings();
  const [stage, setStage] = useState<ChangeStage>("current");
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  // The candidate PIN between stage 2 and stage 3. Lives here only, dies with
  // the surface, and is cleared on every open/close flip below.
  const [newPin, setNewPin] = useState("");

  // Reset on every open/close flip so a reopened flow always starts at stage one
  // with no half-typed candidate behind it , same guarantee PinGateModal makes.
  // `open` is the intended trigger even though the body only calls setters.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on open flip
  useEffect(() => {
    setStage("current");
    setPin("");
    setError(false);
    setNewPin("");
  }, [open]);

  function digit(d: string) {
    setError(false);
    const next = pin + d;
    if (next.length < PIN_LENGTH) {
      setPin(next);
      return;
    }
    setPin("");
    if (stage === "current") {
      // Verify against the live synced PIN, not a constant.
      if (next === pinCode) setStage("new");
      else setError(true);
    } else if (stage === "new") {
      setNewPin(next);
      setStage("confirm");
    } else if (next === newPin) {
      setPinCode(next);
      onChanged();
    } else {
      // Mismatch , restart the new/confirm pair.
      setError(true);
      setStage("new");
      setNewPin("");
    }
  }

  const copy = STAGE_COPY[stage];

  return (
    <PinModalShell
      open={open}
      logTitle="Change PIN"
      backdropTestId="pin-change-backdrop"
      onClose={onClose}
    >
      <PinModalHeader
        icon={<Icon name="lock" s={22} />}
        title={copy.title}
        sub={
          error
            ? stage === "current"
              ? "Wrong PIN, try again"
              : "PINs didn't match, start over"
            : copy.sub
        }
        error={error}
      />
      <PinPadView
        entered={pin.length}
        error={error}
        layout={pinPadLayout}
        // Each stage is its own PIN entry, so each gets its own layout.
        shuffleKey={stage}
        onDigit={digit}
        onBackspace={() => {
          setError(false);
          setPin((p) => p.slice(0, -1));
        }}
      />
      {/* Stage progress , which of the three steps you're on. */}
      <div style={{ display: "flex", gap: 8 }}>
        {STAGES.map((s) => (
          <div
            key={s}
            style={{
              width: 24,
              height: 4,
              borderRadius: 2,
              background: s === stage ? "var(--ink-2)" : "var(--nest)",
            }}
          />
        ))}
      </div>
      <PinModalCancel onClick={onClose} />
    </PinModalShell>
  );
}
