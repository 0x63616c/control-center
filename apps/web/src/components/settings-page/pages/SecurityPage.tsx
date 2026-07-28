/**
 * Security settings page , the keypad-layout picker plus the Change PIN row.
 *
 * The change-PIN machine used to be mounted inline here, permanently on screen,
 * which is why it needed a "PIN changed / Change again" terminal state: a card
 * that cannot dismiss itself has to end on something. It now lives on its own
 * surface (`PinChangeModal`), so this page is just settings rows again (#298).
 * The dialog holds an explicit "PIN changed" beat before it leaves , that is
 * the confirmation, shown where the person is already looking. The row keeps a
 * quieter echo of it for anyone who glanced away as the surface dismissed.
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

/** How long the row echoes "Changed" before falling back to the masked value.
 *  It is the second confirmation, not the only one , the dialog's own success
 *  beat is what a person actually reads , so this only has to outlast a glance
 *  away, and be gone by the time you come back to the page. */
const CONFIRM_MS = 2400;

const MASKED_PIN = "•".repeat(PIN_LENGTH);

const LAYOUT_OPTIONS = PIN_PAD_LAYOUTS.map((value) => ({
  value,
  label: PIN_PAD_LAYOUT_LABEL[value],
}));

/** What each choice actually buys, in the person's terms rather than the threat
 *  model's , the sub-line swaps as you move between them.
 *
 *  Kept to ONE SHORT LINE each, deliberately. These strings swap under a control
 *  you are actively tapping, so a blurb long enough to wrap makes the card grow
 *  a line and shove the keypad below it down mid-interaction. Length parity
 *  matters more than completeness here , the full trade-off for each mode is
 *  documented in PIN_PAD_LAYOUTS, which is where someone reading the code will
 *  look for it anyway. */
const LAYOUT_BLURB: Record<(typeof PIN_PAD_LAYOUTS)[number], string> = {
  fixed: "Same layout every time. Fingerprints give your digits away.",
  rotated: "In order, but starting somewhere new each time.",
  scrambled: "A new arrangement for every unlock.",
  "scrambled-per-key": "A new arrangement after every digit you press.",
};

/** The row is in exactly one of three states, so it is spelled as one value.
 *  Two booleans could represent "changing AND confirmed", which is reachable ,
 *  tap the row again inside the confirmation window and it reads "Changed"
 *  behind a freshly-opened dialog (01-impossible-states). */
type PinRowState = { kind: "idle" } | { kind: "changing" } | { kind: "confirmed" };

export function SecurityPage() {
  const { pinPadLayout } = useSettings();
  const [row, setRow] = useState<PinRowState>({ kind: "idle" });

  // Clear the row's echo on a timer, and on unmount, so navigating away and
  // back never shows a stale "Changed" from an earlier visit.
  useEffect(() => {
    if (row.kind !== "confirmed") return;
    const t = setTimeout(() => setRow({ kind: "idle" }), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [row.kind]);

  return (
    <>
      <SectionCard title="Keypad">
        {[
          <div key="layout" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontFamily: "var(--ui)", fontSize: 15, color: "var(--ink)" }}>
              Keypad layout
            </span>
            {/* Fixed single-line box: the blurb swaps as you tap through the
                segments, and letting it size itself would jog everything below
                it by a line the moment one wrapped. Belt and braces with the
                short copy above , if a future blurb outgrows the line, it gets
                clipped here rather than silently shifting the card. */}
            <span
              style={{
                fontFamily: "var(--ui)",
                fontSize: 12,
                color: "var(--ink-3)",
                height: 16,
                lineHeight: "16px",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
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
                value={row.kind === "confirmed" ? "Changed" : MASKED_PIN}
                tone={row.kind === "confirmed" ? "good" : undefined}
                label="Change PIN"
                onClick={() => setRow({ kind: "changing" })}
              />
            }
          />,
        ]}
      </SectionCard>
      <PinChangeModal
        open={row.kind === "changing"}
        onClose={() => setRow({ kind: "idle" })}
        onChanged={() => setRow({ kind: "confirmed" })}
      />
    </>
  );
}
