/**
 * Security settings page , the scrambled-pad toggle plus the change-PIN flow.
 * The latter is a three-stage machine (verify the current PIN, enter a new one,
 * confirm it) framed in a single Concept-A card. The current PIN is checked
 * against the live synced settings store, and a successful confirm writes the
 * new PIN through `setPinCode` (which syncs it to every panel). Styling + stage
 * machine copied from the approved `PinChangeFlowConcept`. The PIN gates on
 * Settings + Wake photos are always on, so there is no lock-toggle card.
 */

import { useState } from "react";
import { PIN_LENGTH, setPinCode, setScramblePin, useSettings } from "../../../lib/settings";
import { Icon } from "../../Icon";
import { PinPadView } from "../../pin/PinPad";
import { Switch } from "../../ui/Switch";
import { ActionButton, RowShell, SectionCard } from "../blocks";

type ChangeStage = "current" | "new" | "confirm" | "done";

const STAGE_COPY: Record<ChangeStage, { title: string; sub: string }> = {
  current: { title: "Enter current PIN", sub: "Confirm it's you before changing the PIN." },
  new: { title: "Enter new PIN", sub: "Six digits. Used by every panel." },
  confirm: { title: "Confirm new PIN", sub: "Type the new PIN once more." },
  done: { title: "PIN changed", sub: "Synced to all panels." },
};

export function SecurityPage() {
  const { pinCode, scramblePin } = useSettings();
  const [stage, setStage] = useState<ChangeStage>("current");
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const [newPin, setNewPin] = useState("");

  function digit(d: string) {
    if (stage === "done") return;
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
      setStage("done");
    } else {
      // Mismatch , restart the new/confirm pair.
      setError(true);
      setStage("new");
      setNewPin("");
    }
  }

  function restart() {
    setStage("current");
    setPin("");
    setNewPin("");
    setError(false);
  }

  const copy = STAGE_COPY[stage];

  return (
    <>
      <SectionCard title="Keypad">
        {[
          <RowShell
            key="scramble"
            label="Scramble the keypad"
            sub="Shuffle the digits on every prompt, so fingerprints on the glass don't give away which keys your PIN uses."
            control={
              <Switch label="Scramble the keypad" checked={scramblePin} onChange={setScramblePin} />
            }
          />,
        ]}
      </SectionCard>
      <SectionCard title="Change PIN">
        {[
          <div
            key="flow"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 24,
              padding: "22px 0 26px",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div style={{ fontSize: 17, fontWeight: 600 }}>{copy.title}</div>
              <div style={{ fontSize: 13, color: error ? "#c95c5c" : "var(--ink-3)" }}>
                {error
                  ? stage === "current"
                    ? "Wrong PIN, try again"
                    : "PINs didn't match, start over"
                  : copy.sub}
              </div>
            </div>

            {stage === "done" ? (
              <>
                <div style={{ color: "#43a56c", padding: 24 }}>
                  <Icon name="unlock" s={44} />
                </div>
                <ActionButton onClick={restart}>Change again</ActionButton>
              </>
            ) : (
              <>
                <PinPadView
                  entered={pin.length}
                  error={error}
                  scramble={scramblePin}
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
                  {(["current", "new", "confirm"] as const).map((s) => (
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
              </>
            )}
          </div>,
        ]}
      </SectionCard>
    </>
  );
}
