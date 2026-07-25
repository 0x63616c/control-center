/**
 * AllAppsModal , searchable grid of all Apple TV apps (www-51hf.22 / A27).
 *
 * Renders the real source_list apps from the tvApps query. The currently-open
 * app is marked with an accent ring. Search filters the grid in real time.
 * Tapping an app launches it via the tvLaunchApp mutation (the wiring's
 * onLaunchApp also closes the detail page, preserving the old launch-and-close
 * behavior). Bare page body (no <Modal>) , hosted by TileDetailHost.
 */

import { useEffect, useRef, useState } from "react";
import { TvAppMark, tvAppsInOrder } from "./tv-app-logos";

// ── Grid geometry (www-cb57, www-<ticket-66>) ──────────────────────────────────
// The grid viewport flex-fills whatever height TileDetailHost's content region
// actually gives it (rather than a pinned constant , see #66, a pinned height
// left visible dead space whenever the real host region was taller than the
// guessed constant). Underfull results are padded with placeholder cells up to
// a full viewport of rows , computed from the MEASURED height , so the grid
// stays visually full even with zero matches, and stays full when the viewport
// is genuinely tall.

const GRID_COLS = 4;
const GRID_GAP = 10;
// 12px padding + 48px logo + 6px gap + ~14px label + 12px padding.
const CELL_H = 92;
// Rows to pad to before the viewport has been measured (first paint, or in
// environments without ResizeObserver, e.g. jsdom) , matches the old fixed
// 5.5-visible-row design so there's no flash of an under-filled grid.
const FALLBACK_ROWS = 6;

/**
 * Number of grid cells (apps + placeholders) needed to visually fill a
 * viewport of the given measured height. Pure function of the grid geometry
 * so it's directly testable without rendering or a ResizeObserver.
 *
 * `Math.ceil` overshoots the exact row count whenever the height isn't a
 * multiple of the row pitch, which reproduces the old design's "partial row
 * peek" scroll affordance for free.
 */
export function cellsToFillHeight(viewportHeightPx: number): number {
  if (viewportHeightPx <= 0) return GRID_COLS * FALLBACK_ROWS;
  const rows = Math.ceil((viewportHeightPx + GRID_GAP) / (CELL_H + GRID_GAP));
  return GRID_COLS * rows;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AllAppsModalProps {
  apps: string[];
  currentApp: string | null;
  onLaunchApp: (app: string) => void;
}

// ── Main modal ────────────────────────────────────────────────────────────────

export function AllAppsModal({ apps, currentApp, onLaunchApp }: AllAppsModalProps) {
  const [query, setQuery] = useState("");
  const viewportRef = useRef<HTMLDivElement>(null);
  // 0 means "unmeasured" , cellsToFillHeight falls back to FALLBACK_ROWS until
  // the effect below (or its ResizeObserver) reports a real height.
  const [viewportH, setViewportH] = useState(0);

  // The viewport flex-fills TileDetailHost's content region, so the fill
  // target has to follow the measured height rather than a constant , see
  // LogsView's listRef/ResizeObserver for the same pattern.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Favorites first, then logo apps, then glyph-only , same order as the tile.
  const ordered = tvAppsInOrder(apps);
  const filtered = query.trim()
    ? ordered.filter((a) => a.toLowerCase().includes(query.toLowerCase()))
    : ordered;

  return (
    <div
      style={{
        maxWidth: 920,
        margin: "0 auto",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14, flex: 1, minHeight: 0 }}>
        {/* Search */}
        <input
          type="text"
          aria-label="Search apps"
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            background: "var(--tile-2)",
            border: "1px solid var(--tile-3)",
            borderRadius: 8,
            padding: "8px 12px",
            color: "var(--ink-1)",
            fontSize: 14,
            outline: "none",
            width: "100%",
            boxSizing: "border-box",
          }}
        />

        {/* Grid , flex-fills the remaining height so the page always fills the
            real host region instead of a pinned guess (#66); modal-scroll
            hides the scrollbar (kiosk style). */}
        <div
          ref={viewportRef}
          data-testid="apps-grid-viewport"
          className="modal-scroll"
          style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`,
              gridAutoRows: CELL_H,
              gap: GRID_GAP,
            }}
          >
            {filtered.map((app) => {
              const isActive = app === currentApp;
              return (
                <button
                  key={app}
                  type="button"
                  data-active-app={isActive ? "true" : undefined}
                  aria-label={`Launch ${app}`}
                  onClick={() => onLaunchApp(app)}
                  style={{
                    padding: "12px 8px",
                    borderRadius: 12,
                    border: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                    background: "var(--tile-2)",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  {/* Full-color brand mark (or 2-letter monospace glyph fallback) */}
                  <div
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: 12,
                      background: "var(--tile-3)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      overflow: "hidden",
                    }}
                  >
                    <TvAppMark name={app} size={34} />
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      color: isActive ? "var(--accent)" : "var(--ink-2)",
                      textAlign: "center",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: "100%",
                    }}
                  >
                    {app}
                  </span>
                </button>
              );
            })}

            {/* Placeholder cells keep the grid visually full when results
                underfill the viewport (including zero matches). */}
            {Array.from(
              { length: Math.max(0, cellsToFillHeight(viewportH) - filtered.length) },
              (_, i) => (
                <div
                  // Cells are interchangeable blanks; position is identity.
                  // biome-ignore lint/suspicious/noArrayIndexKey: static decorative fillers
                  key={i}
                  data-testid="app-placeholder"
                  aria-hidden="true"
                  style={{
                    borderRadius: 12,
                    background: "var(--tile-2)",
                    opacity: 0.35,
                  }}
                />
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
