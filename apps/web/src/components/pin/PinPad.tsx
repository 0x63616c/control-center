/**
 * PinPad , dumb presentational keypad: entered-count dots + a 3x4 pad. The
 * parent owns all state (how many digits entered, error flag) and reacts to
 * onDigit/onBackspace , this component never sees or stores the PIN itself.
 * Copied from the approved PinConcepts visual reference.
 *
 * The digit LAYOUT moves (#287, #291, #302). On a `fixed` pad the same four
 * keys are touched at every unlock, so grease/smudge wear on the panel glass
 * leaks which digits the PIN is made of , that collapses the search space from
 * 10^4 to at most 24 orderings. The moving layouts spread that wear across all
 * ten keys; they differ in what they cost the person typing:
 *
 *   `scrambled` , a fresh uniform permutation. Strongest per-prompt layout, and
 *     the most expensive to read: ten independent lookups, every prompt, forever.
 *   `rotated` , ascending order kept, random starting digit. Find one digit and
 *     the rest follow, so it reads far faster than a permutation. Weaker: there
 *     are only ten layouts, and a SINGLE session's fresh smudges (on clean
 *     glass) still give the PIN up to a rotation, because rotation preserves the
 *     gaps between the keys pressed. Against accumulated wear , the actual
 *     threat on a panel used daily , it is as good as scrambling.
 *   `scrambled-per-key` , a fresh permutation after EVERY digit entered. This is
 *     the one mode that deliberately moves MID-ENTRY, and it is a different
 *     threat model, not a stronger dial on the same one: smudge wear is about
 *     what the glass remembers, this is about what a person standing behind you
 *     sees. Watching the finger yields six positions that each meant a different
 *     digit, so the observation is worthless. Paid for in re-scans: six per
 *     unlock instead of one.
 *
 * Which one is the caller's call, driven by the `pinPadLayout` setting.
 */

import type { PinPadLayout } from "@cc/api/settings";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { PIN_LENGTH } from "../../lib/settings";
import { Icon } from "../Icon";

/** Pad order as positions, not as values: the first nine fill the 3x3 block and
 *  the tenth sits in the bottom-centre cell. In standard order that is the
 *  familiar phone pad; the moving layouts fill the same ten cells differently. */
const STANDARD_DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"] as const;

/** Uniform random integer in [0, n). Rejection-sampled off getRandomValues , a
 *  plain `% n` over 2^32 is biased, and the whole point of this feature is not
 *  handing an attacker structure. */
function randomBelow(n: number): number {
  // Largest multiple of n that fits in a uint32; draws at or above it are
  // rejected so every residue is equally likely.
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  let value = limit;
  while (value >= limit) {
    crypto.getRandomValues(buf);
    value = buf[0] ?? 0;
  }
  return value % n;
}

/**
 * A fresh random permutation of the ten digits (selection-sampled Fisher-Yates,
 * so it is uniform over all 10! orders). Exported for tests and Storybook.
 */
export function scrambledDigits(): string[] {
  const pool: string[] = [...STANDARD_DIGITS];
  const out: string[] = [];
  while (pool.length > 0) out.push(...pool.splice(randomBelow(pool.length), 1));
  return out;
}

/**
 * The standard order, cyclically shifted by a random amount: 4 5 6 / 7 8 9 /
 * 0 1 2 / 3, say. Every digit is equally likely to land in any cell (uniform k
 * over ten shifts), so wear spreads exactly as evenly as a full shuffle does ,
 * but the sequence stays ascending, which is what makes it scannable.
 *
 * k = 0 (the standard pad) is left in the draw: excluding it would make "no
 * shift" the one outcome an observer could rule out, and it costs nothing to
 * allow. Exported for tests and Storybook.
 */
export function rotatedDigits(): string[] {
  const k = randomBelow(STANDARD_DIGITS.length);
  return [...STANDARD_DIGITS.slice(k), ...STANDARD_DIGITS.slice(0, k)];
}

function layoutFor(layout: PinPadLayout): string[] {
  if (layout === "scrambled" || layout === "scrambled-per-key") return scrambledDigits();
  if (layout === "rotated") return rotatedDigits();
  return [...STANDARD_DIGITS];
}

export function PinPadView({
  entered,
  error,
  layout = "fixed",
  shuffleKey,
  onDigit,
  onBackspace,
}: {
  entered: number;
  /** Paints the dots red (wrong PIN) until the next digit. */
  error?: boolean;
  /** How to arrange the digits (see the module header). */
  layout?: PinPadLayout;
  /** Change this to force a reshuffle without remounting , one prompt per
   *  value. Callers that unmount the pad between prompts can skip it. */
  shuffleKey?: string | number;
  onDigit: (d: string) => void;
  onBackspace: () => void;
}) {
  // The live layout. Seeded on mount and replaced whenever the caller starts a
  // new prompt (shuffleKey) or flips the setting.
  const [digits, setDigits] = useState<string[]>(() => layoutFor(layout));

  // The one deliberate mid-entry redraw, kept to a single expression so the two
  // behaviours cannot blur into each other.
  //
  // Every layout except `scrambled-per-key` must hold still for the whole of one
  // entry: keys shifting under a half-typed PIN is how you mistype it, and those
  // modes buy nothing by moving sooner (smudge wear accumulates across sessions,
  // so one redraw per prompt already spreads it). For them this pins to a
  // constant, which makes `entered` drop out of the dependency list entirely ,
  // their redraw timing is bit-identical to before #302.
  //
  // `scrambled-per-key` inverts exactly that invariant on purpose: its threat is
  // the person watching your hand, and the only way to make a watched finger
  // position meaningless is to reassign it before the next press. The mistype
  // cost is real and is what the person is choosing when they pick this mode.
  // Backspace ticks it too (`entered` falls), which is correct , a corrected
  // digit is still a digit an observer saw pressed.
  const perKeyRedraw = layout === "scrambled-per-key" ? entered : 0;

  // `shuffleKey`/`perKeyRedraw` are the intended triggers even though the body
  // only reads `layout`; that is the whole point of those values.
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw per prompt (all modes) and per keypress (scrambled-per-key only)
  useEffect(() => {
    setDigits(layoutFor(layout));
  }, [layout, shuffleKey, perKeyRedraw]);

  // Keyboard support: digit keys append, Backspace/Delete remove. Routed
  // through refs (same pattern as PinGateModal's onCloseRef/onSuccessRef) so
  // the listener attaches once on mount rather than detaching/reattaching on
  // every keystroke , both real callers (PinGateModal, PinChangeModal) pass a
  // fresh onDigit/onBackspace identity every render.
  //
  // NB: this listener is per-mounted-instance. Today only one PinPadView is
  // ever mounted at a time: both callers are PIN dialogs, each renders its pad
  // only while open, and the gate runs before Settings exists rather than over
  // it. So a single global listener is safe. If a future screen ever renders
  // two PinPadViews simultaneously, both would receive every keydown , worth
  // revisiting then.
  const onDigitRef = useRef(onDigit);
  onDigitRef.current = onDigit;
  const onBackspaceRef = useRef(onBackspace);
  onBackspaceRef.current = onBackspace;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Let Cmd/Ctrl/Alt shortcuts (e.g. Cmd+0 zoom-reset, Ctrl+Backspace
      // word-delete) through untouched instead of also mutating the PIN.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        onDigitRef.current(e.key);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        // Prevent browser/webview back-navigation on Backspace outside a
        // focused input , this panel runs in a Capacitor shell.
        e.preventDefault();
        onBackspaceRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Tenth cell (bottom-centre, where 0 sits in the standard layout). The `??` is
  // unreachable , layoutFor always returns ten , it just keeps the render total
  // rather than leaning on the index type.
  const bottomDigit = digits[9] ?? "0";

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24 }}>
      {/* Entry dots */}
      <div style={{ display: "flex", gap: 14 }}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length positions
            key={i}
            style={{
              width: 14,
              height: 14,
              borderRadius: "50%",
              border: `1.5px solid ${error ? "#c95c5c" : "var(--hair-3)"}`,
              background: i < entered ? (error ? "#c95c5c" : "var(--ink)") : "transparent",
              transition: "background 80ms",
            }}
          />
        ))}
      </div>

      {/* Keypad */}
      {/* No gap: each cell is 84px and the button fills it, so the 12px gutter
          between the painted 72px circles is still tappable (Apple-style: the
          hit target is the grid cell, the circle is only paint). */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 84px)", gap: 0 }}>
        {/* Keyed by POSITION, not by digit: the press-feedback state belongs to
            the cell under the finger, and re-keying on every shuffle would also
            throw away and rebuild all ten buttons. */}
        {digits.slice(0, 9).map((d, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length positions
          <PadKey key={i} onClick={() => onDigit(d)} label={d} />
        ))}
        <div />
        <PadKey label={bottomDigit} onClick={() => onDigit(bottomDigit)} />
        <PadKey label="backspace" onClick={onBackspace}>
          <span style={{ transform: "rotate(180deg)", display: "flex" }}>
            {/* No dedicated backspace glyph in the icon set; chevron reads fine. */}
            <Icon name="chevron" s={22} />
          </span>
        </PadKey>
      </div>
    </div>
  );
}

function PadKey({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  const [pressed, setPressed] = useState(false);

  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      style={{
        // 84x84 hit target = the full grid cell; 6px padding insets the painted
        // circle back to 72px so the visual layout is unchanged.
        width: 84,
        height: 84,
        padding: 6,
        background: "transparent",
        border: "none",
        cursor: "pointer",
        // Kills the 300ms double-tap-zoom delay and the grey flash in the iOS
        // Capacitor shell; the panel is fixed-size so zoom is never wanted.
        touchAction: "manipulation",
        WebkitTapHighlightColor: "transparent",
        userSelect: "none",
      }}
    >
      <span
        style={{
          width: "100%",
          height: "100%",
          borderRadius: "50%",
          background: pressed ? "var(--hair)" : "var(--nest)",
          border: "1px solid var(--hair)",
          color: "var(--ink)",
          fontFamily: "var(--ui)",
          fontSize: 26,
          fontWeight: 500,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "background 80ms",
        }}
      >
        {children ?? label}
      </span>
    </button>
  );
}
