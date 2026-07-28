/**
 * PinPad , dumb presentational keypad: entered-count dots + a 3x4 pad. The
 * parent owns all state (how many digits entered, error flag) and reacts to
 * onDigit/onBackspace , this component never sees or stores the PIN itself.
 * Copied from the approved PinConcepts visual reference.
 *
 * The digit LAYOUT is optionally scrambled (#287). On a fixed layout the same
 * four keys are touched at every unlock, so grease/smudge wear on the panel
 * glass leaks which digits the PIN is made of , that collapses the search space
 * from 10^4 to at most 24 permutations. Reshuffling per prompt spreads wear
 * evenly across all ten keys. Whether to do it is the caller's call (it costs
 * muscle memory), driven by the `scramblePin` setting.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { PIN_LENGTH } from "../../lib/settings";
import { Icon } from "../Icon";

/** Pad order as positions, not as values: the first nine fill the 3x3 block and
 *  the tenth sits in the bottom-centre cell. In standard order that is the
 *  familiar phone pad; scrambled, the same ten cells hold a random permutation. */
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

function layoutFor(scramble: boolean): string[] {
  return scramble ? scrambledDigits() : [...STANDARD_DIGITS];
}

export function PinPadView({
  entered,
  error,
  scramble = false,
  shuffleKey,
  onDigit,
  onBackspace,
}: {
  entered: number;
  /** Paints the dots red (wrong PIN) until the next digit. */
  error?: boolean;
  /** Randomize the digit positions (see the module header). */
  scramble?: boolean;
  /** Change this to force a reshuffle without remounting , one prompt per
   *  value. Callers that unmount the pad between prompts can skip it. */
  shuffleKey?: string | number;
  onDigit: (d: string) => void;
  onBackspace: () => void;
}) {
  // The live layout. Seeded on mount and replaced whenever the caller starts a
  // new prompt (shuffleKey) or flips the setting , never mid-entry, since
  // moving keys under a half-typed PIN is how you mistype it.
  const [digits, setDigits] = useState<string[]>(() => layoutFor(scramble));
  // `shuffleKey` is the intended trigger even though the body only reads
  // `scramble`; that is the whole point of the prop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reshuffle per prompt
  useEffect(() => {
    setDigits(layoutFor(scramble));
  }, [scramble, shuffleKey]);

  // Keyboard support: digit keys append, Backspace/Delete remove. Routed
  // through refs (same pattern as PinGateModal's onCloseRef/onSuccessRef) so
  // the listener attaches once on mount rather than detaching/reattaching on
  // every keystroke , both real callers (PinGateModal, SecurityPage) pass a
  // fresh onDigit/onBackspace identity every render.
  //
  // NB: this listener is per-mounted-instance. Today only one PinPadView is
  // ever mounted at a time (PinGateModal is exclusive-open; SecurityPage is a
  // single settings sub-page), so a single global listener is safe. If a
  // future screen ever renders two PinPadViews simultaneously, both would
  // receive every keydown , worth revisiting then.
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
