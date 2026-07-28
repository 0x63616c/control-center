/**
 * Shared presentational building blocks for the full-page Settings pages,
 * lifted from approved Concept A (`SettingsConceptGroupedCards`). Every page is
 * a stack of `SectionCard`s framing keyed rows; rows are `RowShell` /
 * `SliderRow` / control primitives. These carry zero data , pages wire real
 * store state into them.
 */

import type { CSSProperties, ReactElement, ReactNode } from "react";
import { Icon } from "../Icon";

const VALUE_TEXT: CSSProperties = { fontFamily: "var(--mono)", fontSize: 14, color: "var(--ink)" };

const ACTION_BUTTON: CSSProperties = {
  padding: "8px 14px",
  background: "var(--nest)",
  border: "1px solid var(--hair)",
  borderRadius: 10,
  fontFamily: "var(--ui)",
  fontSize: 13,
  color: "var(--ink-2)",
  cursor: "pointer",
};

/** The page's title + one-line blurb, above its section cards. */
export function PageHeader({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div>
      <h2 style={{ margin: 0, fontSize: 24, fontWeight: 650 }}>{title}</h2>
      <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--ink-3)" }}>{blurb}</p>
    </div>
  );
}

/**
 * A titled inset card: a mono uppercase label over a rounded card whose rows
 * are separated by hairlines. Each child carries its own stable `key`, reused
 * for the wrapping padding div and its top border (matching the concept).
 */
export function SectionCard({ title, children }: { title: string; children: ReactElement[] }) {
  return (
    <section>
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--ink-3)",
          margin: "0 4px 8px",
        }}
      >
        {title}
      </div>
      <div
        style={{
          background: "var(--tile)",
          border: "1px solid var(--hair)",
          borderRadius: 16,
          overflow: "hidden",
        }}
      >
        {children.map((row, i) => (
          <div
            key={row.key}
            style={{
              padding: "14px 20px",
              borderTop: i === 0 ? "none" : "1px solid var(--hair)",
            }}
          >
            {row}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * A label (+ optional sub-line) on the left, a control on the right.
 *
 * `stack` drops the control onto its own full-width line below the label
 * instead. For controls that are a LIST rather than a widget (the typeface
 * picker's option rows): squeezing those into the right-hand column would leave
 * the label orphaned against a tall block, and they have their own internal
 * left edge to align to.
 */
export function RowShell({
  label,
  sub,
  control,
  stack,
}: {
  label: string;
  sub?: string;
  control: ReactNode;
  stack?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: stack ? "column" : "row",
        alignItems: stack ? "stretch" : "center",
        justifyContent: stack ? undefined : "space-between",
        gap: stack ? 12 : 24,
        minHeight: 40,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontFamily: "var(--ui)", fontSize: 15, color: "var(--ink)" }}>{label}</span>
        {sub ? (
          <span style={{ fontFamily: "var(--ui)", fontSize: 12, color: "var(--ink-3)" }}>
            {sub}
          </span>
        ) : null}
      </div>
      <div style={{ flexShrink: 0 }}>{control}</div>
    </div>
  );
}

/**
 * Wrapper for a full-width slider row. Sliders end in a thin rail, so a tighter
 * padding evens out the optical spacing under them vs text rows.
 */
export function SliderRow({ children }: { children: ReactNode }) {
  return <div style={{ padding: "2px 0 6px" }}>{children}</div>;
}

/**
 * A mono value with a trailing chevron; a plain span, or a button when onClick.
 *
 * `label` names the button for screen readers and tests when the value alone
 * doesn't (the Change PIN row's value is a row of mask dots, which says nothing
 * about what tapping it does); the row's own label text is not associated with
 * the control, so it can't stand in.
 */
export function ChevronValue({
  value,
  label,
  onClick,
}: {
  value: string;
  label?: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      {value}
      <span style={{ color: "var(--ink-3)" }}>
        <Icon name="chevron" s={16} />
      </span>
    </>
  );
  const style: CSSProperties = {
    ...VALUE_TEXT,
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
  };
  if (onClick) {
    return (
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        style={{ ...style, background: "none", border: "none", padding: 0, cursor: "pointer" }}
      >
        {inner}
      </button>
    );
  }
  return <span style={style}>{inner}</span>;
}

/** A small secondary action button (Edit layout, Start, View logs, ...). */
export function ActionButton({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} style={ACTION_BUTTON}>
      {children}
    </button>
  );
}

/** The chevron-only back affordance placed left of the "Settings" heading. */
export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Back to board"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 38,
        height: 38,
        padding: 0,
        background: "var(--nest)",
        border: "1px solid var(--hair)",
        borderRadius: 12,
        color: "var(--ink-2)",
        cursor: "pointer",
        flexShrink: 0,
        transform: "rotate(180deg)",
      }}
    >
      <Icon name="chevron" s={20} />
    </button>
  );
}
