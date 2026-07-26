/**
 * VariantSwitcher , floating segmented selector that sits ABOVE the open detail
 * page and lets you swap between a tile's designed detail variants live.
 *
 * Portaled to <body> (like the detail page) as a fixed, top-centered pill bar
 * layered above the page overlay (zIndex 110 > the page's 100). The portal is
 * load-bearing: in-tree it lives under #stage's own stacking context and 110
 * would never beat the body-level overlay. Only shown when a tile has >1
 * variant.
 */

import { createPortal } from "react-dom";
import type { DetailVariant } from "../detail/types";

export interface VariantSwitcherProps {
  // Only slug + label (+ the optional badge dot) are read, so any variant list
  // (DetailVariant, or a caller's own {slug,label} shapes like
  // PartySpeedControls') satisfies this.
  variants: Pick<DetailVariant, "slug" | "label" | "badge">[];
  activeSlug: string;
  onSelect: (slug: string) => void;
}

export function VariantSwitcher({ variants, activeSlug, onSelect }: VariantSwitcherProps) {
  // Portal to <body> so the switcher shares the Modal's body-level stacking
  // context. The Modal portals to <body> too (zIndex 100); rendered in-tree the
  // switcher sits inside #stage (position:fixed → its own stacking context), so
  // its zIndex:110 would be scoped to #stage and never beat the body-level
  // Modal , leaving it buried behind the backdrop. Same context ⇒ 110 > 100 wins.
  return createPortal(
    <div
      // Fixed top-center, above the Modal (z 100). pointerEvents none on the
      // wrapper so it never blocks backdrop clicks outside the pill bar itself.
      style={{
        position: "fixed",
        top: 18,
        left: 0,
        right: 0,
        zIndex: 110,
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div
        role="tablist"
        aria-label="Modal variant"
        style={{
          display: "flex",
          gap: 4,
          padding: 4,
          maxWidth: "92vw",
          overflowX: "auto",
          background: "var(--tile)",
          border: "1px solid var(--hair)",
          borderRadius: 999,
          boxShadow: "0 12px 32px -12px rgba(0,0,0,0.7)",
          pointerEvents: "auto",
        }}
      >
        {variants.map((v) => {
          const active = v.slug === activeSlug;
          return (
            <button
              key={v.slug}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelect(v.slug)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                whiteSpace: "nowrap",
                // Hit-area law: wall-panel pills carry a 44px touch target.
                minHeight: 44,
                padding: "7px 16px",
                borderRadius: 999,
                border: "none",
                cursor: "pointer",
                font: "inherit",
                fontSize: 13,
                fontWeight: 500,
                color: active ? "var(--bg)" : "var(--ink-2)",
                background: active ? "var(--acc)" : "transparent",
              }}
            >
              {v.label}
              {v.badge ? (
                // Attention dot (e.g. a done timer while another variant is up).
                // On the active pill the accent IS the background, so the dot
                // inverts to stay visible.
                <span
                  data-testid={`variant-badge-${v.slug}`}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: active ? "var(--bg)" : "var(--acc)",
                  }}
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
