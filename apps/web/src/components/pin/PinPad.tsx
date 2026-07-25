/**
 * PinPad , dumb presentational keypad: entered-count dots + a 3x4 pad. The
 * parent owns all state (how many digits entered, error flag) and reacts to
 * onDigit/onBackspace , this component never sees or stores the PIN itself.
 * Copied from the approved PinConcepts visual reference.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { PIN_LENGTH } from "../../lib/settings";
import { Icon } from "../Icon";

export function PinPadView({
  entered,
  error,
  onDigit,
  onBackspace,
}: {
  entered: number;
  /** Paints the dots red (wrong PIN) until the next digit. */
  error?: boolean;
  onDigit: (d: string) => void;
  onBackspace: () => void;
}) {
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
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <PadKey key={d} onClick={() => onDigit(d)} label={d} />
        ))}
        <div />
        <PadKey label="0" onClick={() => onDigit("0")} />
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
