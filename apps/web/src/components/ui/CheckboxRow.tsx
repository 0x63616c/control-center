/**
 * CheckboxRow , standalone dumb presentational checkbox + inline label row.
 * Zero trpc/data/hook dependencies; all state driven by props. Error state
 * shares the row (checkbox tints, message renders right-aligned) mirroring
 * Field's label-row error so toggling it never reflows the control below.
 * Ported from the captive-portal guest primitives, restyled onto cc tokens.
 */

import type { ReactNode } from "react";
import { fieldErrorId } from "./Field";

export interface CheckboxRowProps {
  id: string;
  checked: boolean;
  error?: boolean;
  /** Validation message, rendered right-aligned at the end of the row.
   *  Mirrors Field's label-row error placement. */
  errorMessage?: string;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}

export function CheckboxRow({
  id,
  checked,
  error,
  errorMessage,
  onChange,
  children,
}: CheckboxRowProps) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        aria-invalid={error || undefined}
        aria-describedby={errorMessage ? fieldErrorId(id) : undefined}
        onChange={(e) => onChange(e.target.checked)}
        // .wwb-checkbox (tokens.css) fully themes the box , native checkbox
        // chrome renders an unthemed white box on several platforms until
        // checked, `accent-color` alone only themes the fill (#76).
        className={error ? "wwb-checkbox error" : "wwb-checkbox"}
        style={{ flexShrink: 0, marginTop: 2 }}
      />
      <label
        htmlFor={id}
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: "var(--ui)",
          fontSize: 13.5,
          color: "var(--ink-2)",
          lineHeight: 1.4,
        }}
      >
        {children}
      </label>
      {/* Always rendered (role=alert only when populated) so toggling it never
          reflows the submit control below. */}
      <div
        id={fieldErrorId(id)}
        role={errorMessage ? "alert" : undefined}
        aria-live="polite"
        style={{
          flexShrink: 0,
          color: "var(--red, #e5484d)",
          fontSize: 12,
        }}
      >
        {errorMessage}
      </div>
    </div>
  );
}
