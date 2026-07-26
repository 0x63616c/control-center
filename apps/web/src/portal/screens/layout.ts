import type { CSSProperties } from "react";

// Shared stage/column/type styles across the guest screens. Ported layout
// intent from the source's wwb-stage / wwb-col / wwb-h1 / wwb-sub CSS classes
// (products/captive-portal/apps/frontend/src/styles/theme.css), restyled as
// plain style objects (no CSS classes) per the cc idiom. No fixed widths , the
// guest screens run on phones, so `stage` centers a column that shrinks to
// its own maxWidth rather than assuming a fixed viewport.
//
// minHeight is a viewport unit (100dvh), NOT a percentage (#76): #portal-root
// only sets min-height in portal.css, and a percentage height on `stage` can't
// resolve against an ancestor whose own height is itself only a min-height ,
// per spec that computes to auto, so `stage` collapsed to its content height
// and the flex centering had no extra room to center within (content pinned
// to the top). dvh sidesteps the ancestor chain entirely and also tracks
// mobile Safari's dynamic toolbar, which plain vh does not.
export const stage: CSSProperties = {
  position: "relative",
  zIndex: 1,
  flex: "1 1 auto",
  minHeight: "100dvh",
  width: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  boxSizing: "border-box",
};

export const stageTerms: CSSProperties = {
  ...stage,
  alignItems: "flex-start",
  padding: "40px 24px",
};

export const col: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  margin: "auto",
};

export const h1: CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  letterSpacing: "-0.02em",
  lineHeight: 1.25,
  margin: 0,
  color: "var(--ink)",
};

export const sub: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.55,
  color: "var(--ink-2)",
  margin: 0,
};

/** Secondary text-only action below the primary Button (e.g. "Start over",
 *  "Not you? Sign in again"). Ported from the source's .wwb-textbtn class. */
export const textBtn: CSSProperties = {
  marginTop: 14,
  background: "none",
  border: "none",
  cursor: "pointer",
  fontFamily: "var(--ui)",
  fontSize: 13,
  color: "var(--ink-2)",
};
