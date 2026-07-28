/**
 * Security settings page , the keypad-layout picker plus the Change PIN row.
 *
 * The change-PIN machine used to be mounted inline here, permanently on screen,
 * which is why it needed a "PIN changed / Change again" terminal state: a card
 * that cannot dismiss itself has to end on something. It now lives on its own
 * surface (`PinChangeModal`), so this page is just settings rows again and
 * success is the flow disappearing (#298) , with a brief confirmation on the row
 * itself, since a dismissal alone leaves nothing to tell you it worked.
 *
 * The PIN gates on Settings + Wake photos are always on, so there is no
 * lock-toggle card.
 */

import { useEffect, useState } from "react";
import {
  PIN_LENGTH,
  PIN_PAD_LAYOUT_LABEL,
  PIN_PAD_LAYOUTS,
  setPinPadLayout,
  useSettings,
} from "../../../lib/settings";
import { PinChangeModal } from "../../pin/PinChangeModal";
import { Segmented } from "../../ui/Segmented";
import { ChevronValue, RowShell, SectionCard } from "../blocks";

/** How long the row says "Changed" before falling back to the masked value.
 *  Long enough to read after the surface dismisses, short enough that it is
 *  gone by the time you come back to the page. */
const CONFIRM_MS = 2400;

const MASKED_PIN = "•".repeat(PIN_LENGTH);

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
  const { pinPadLayout } = useSettings();
  const [changing, setChanging] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  // Clear the row's confirmation on a timer, and on unmount, so navigating away
  // and back never shows a stale "Changed" from an earlier visit.
  useEffect(() => {
    if (!confirmed) return;
    const t = setTimeout(() => setConfirmed(false), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [confirmed]);

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
      <SectionCard title="PIN">
        {[
          <RowShell
            key="change"
            label="Change PIN"
            sub="Six digits. Used by every panel."
            control={
              <ChevronValue
                value={confirmed ? "Changed" : MASKED_PIN}
                label="Change PIN"
                onClick={() => setChanging(true)}
              />
            }
          />,
        ]}
      </SectionCard>
      <PinChangeModal
        open={changing}
        onClose={() => setChanging(false)}
        onChanged={() => {
          setChanging(false);
          setConfirmed(true);
        }}
      />
    </>
  );
}
