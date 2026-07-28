/**
 * Security settings page , the keypad-layout picker plus the change-PIN flow.
 * The latter is a three-stage machine (verify the current PIN, enter a new one,
 * confirm it) framed in a single Concept-A card. The current PIN is checked
 * against the live synced settings store, and a successful confirm writes the
 * new PIN through `setPinCode` (which syncs it to every panel). Styling + stage
 * machine copied from the approved `PinChangeFlowConcept`. The PIN gates on
 * Settings + Wake photos are always on, so there is no lock-toggle card.
 */

import { useState } from "react";
import {
  PIN_LENGTH,
  PIN_PAD_LAYOUT_LABEL,
  PIN_PAD_LAYOUTS,
  setPinCode,
  setPinPadLayout,
  useSettings,
} from "../../../lib/settings";
import { Icon } from "../../Icon";
import { PinPadView } from "../../pin/PinPad";
import { Segmented } from "../../ui/Segmented";
import { ActionButton, SectionCard } from "../blocks";

type ChangeStage = "current" | "new" | "confirm" | "done";

const STAGE_COPY: Record<ChangeStage, { title: string; sub: string }> = {
  current: { title: "Enter current PIN", sub: "Confirm it's you before changing the PIN." },
  new: { title: "Enter new PIN", sub: "Six digits. Used by every panel." },
  confirm: { title: "Confirm new PIN", sub: "Type the new PIN once more." },
  done: { title: "PIN changed", sub: "Synced to all panels." },
};

const LAYOUT_OPTIONS = PIN_PAD_LAYOUTS.map((value) => ({
  value,
  label: PIN_PAD_LAYOUT_LABEL[value],
}));

/** What each choice actually buys, in the person's terms rather than the threat
 *  model's , the sub-line swaps as you move between them. */
const LAYOUT_BLURB: Record<(typeof PIN_PAD_LAYOUTS)[number], string> = {
  fixed:
    "Always the same keypad. Fastest to type, but fingerprints build up on your four digits and give them away.",
  rotated:
    "Digits stay in order but start somewhere new each time. Still easy to read, and the wear spreads over every key.",
  scrambled:
    "Every digit somewhere new each time. Hides the most, and you'll have to look for each key.",
};

export function SecurityPage() {
  const { pinCode, pinPadLayout } = useSettings();
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
          <div key="layout" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontFamily: "var(--ui)", fontSize: 15, color: "var(--ink)" }}>
              Keypad layout
            </span>
            <span style={{ fontFamily: "var(--ui)", fontSize: 12, color: "var(--ink-3)" }}>
              {LAYOUT_BLURB[pinPadLayout]}
            </span>
            <Segmented
              label="Keypad layout"
              options={LAYOUT_OPTIONS}
              value={pinPadLayout}
              onChange={setPinPadLayout}
            />
          </div>,
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
