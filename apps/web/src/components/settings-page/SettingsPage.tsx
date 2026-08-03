/**
 * SettingsPage , the full-page (1366x1024) Settings overlay that replaces the
 * old settings modal. A body-portal fixed overlay (same pattern as the modal /
 * LevelOverlay) laid out per approved Concept A: a 340px tinted-chip sidebar
 * owning page selection, and a scrolling content column that renders the active
 * page component.
 *
 * Page bodies live in `pages/` and register into `PAGE_COMPONENTS` below; a
 * missing key renders nothing (later tasks fill every key). All page components
 * share `PageProps` so the shell can pass its close/overlay callbacks through.
 */

import type { ComponentType } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeToClose } from "../../lib/escape-stack";
import { interaction } from "../../lib/log/interaction";
import { registerOpenModal } from "../../lib/modal-open-store";
import { useIsNarrow } from "../../lib/useIsNarrow";
import { Z_LAYER } from "../../lib/z-layers";
import { Icon } from "../Icon";
import { BackButton, PageHeader } from "./blocks";
import { PAGE_BY_KEY, PAGES, type PageKey } from "./pages";
import { BoardPage } from "./pages/BoardPage";
import { DevicePage } from "./pages/DevicePage";
import { DisplayPage } from "./pages/DisplayPage";
import { LogsPage } from "./pages/LogsPage";
import { NetworkPage } from "./pages/NetworkPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { SecurityPage } from "./pages/SecurityPage";
import { SoundPage } from "./pages/SoundPage";
import { TimePage } from "./pages/TimePage";

export type PageProps = {
  onClose: () => void;
  onOpenLevel: () => void;
  onOpenClean: () => void;
};

/**
 * The active-page component registry. Empty for now , page tasks slot their
 * component in under its key. A key with no entry renders nothing.
 */
const PAGE_COMPONENTS: Partial<Record<PageKey, ComponentType<PageProps>>> = {
  device: DevicePage,
  display: DisplayPage,
  sound: SoundPage,
  board: BoardPage,
  network: NetworkPage,
  notifications: NotificationsPage,
  security: SecurityPage,
  time: TimePage,
  logs: LogsPage,
};

export function SettingsPage({
  open,
  onClose,
  onOpenLevel,
  onOpenClean,
  initialPage,
}: {
  open: boolean;
  onClose: () => void;
  onOpenLevel: () => void;
  onOpenClean: () => void;
  /**
   * The page to land on when the overlay opens (a deep link, e.g. the Logs tile
   * routing to the Logs page). When set, the shell also skips straight into the
   * page on a narrow viewport rather than showing the sidebar list. Defaults to
   * the Device page. Applied by the open-transition effect below , this shell is
   * NOT remounted per open, so a useState seed alone would not re-apply it.
   */
  initialPage?: PageKey;
}) {
  const [page, setPage] = useState<PageKey>("device");

  // On a phone the sidebar and content cannot sit side by side (a 340px sidebar
  // leaves ~100px of content on a 440px viewport, which is what shipped and was
  // unusable). Narrow viewports instead drill down: the list IS the screen, and
  // picking a page replaces it. Wide viewports are untouched , `showList` is
  // simply ignored there, so the wall panel and iPad keep the two-column layout.
  const narrow = useIsNarrow();
  const [showList, setShowList] = useState(true);

  // Apply the landing page on every open transition, then reset to Device on
  // close. This shell is NOT remounted per open (SettingsButton keeps it
  // mounted and flips `open`), so a `useState(initialPage)` seed would only
  // ever apply once , the effect is what re-applies a deep link each time.
  // A deep link (initialPage set) also drills straight into the page on a
  // narrow viewport instead of showing the sidebar list.
  useEffect(() => {
    if (open) {
      setPage(initialPage ?? "device");
      setShowList(!initialPage);
    } else {
      setPage("device");
      setShowList(true);
    }
  }, [open, initialPage]);

  // Freeze the board's pan for the overlay's lifetime and let the board's idle
  // reset dismiss it. Ref-routed so a fresh onClose closure never re-registers.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    return registerOpenModal(() => onCloseRef.current());
  }, [open]);

  // Interaction log for the open/close lifecycle, mirroring Modal.tsx.
  useEffect(() => {
    if (!open) return;
    const target = "modal.Settings full page";
    interaction("modal", "open", target);
    return () => interaction("modal", "close", target);
  }, [open]);

  // Escape-to-close, only while open AND only while nothing is open on top of
  // us , a PIN dialog over Settings owns Escape until it closes (#298).
  useEscapeToClose(open, onClose);

  if (!open) return null;

  const active = PAGE_BY_KEY[page];
  const ActivePage = PAGE_COMPONENTS[page];
  // A `fill` page (the log viewer) owns its own internal scroll region and needs
  // a definite full height with no 720px column cap; every other page keeps the
  // scrolling, centered 720px column.
  const fill = active.fill ?? false;

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: Z_LAYER.pageOverlay,
        display: "flex",
        background: "var(--bg)",
        color: "var(--ink)",
        fontFamily: "var(--ui)",
        overflow: "hidden",
        // Keep content clear of the notch / Dynamic Island and the home
        // indicator. index.html sets viewport-fit=cover, so without this the
        // overlay draws under both and the "Settings" heading is unreadable.
        // Padding (not inset) so the background still fills those regions.
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        paddingLeft: "env(safe-area-inset-left, 0px)",
        paddingRight: "env(safe-area-inset-right, 0px)",
        boxSizing: "border-box",
      }}
    >
      {/* Sidebar , full-width and the only pane when narrow, hidden once a page
          is open there. Fixed 340px column on the panel/iPad, always visible. */}
      <div
        style={{
          width: narrow ? "100%" : 340,
          flexShrink: 0,
          display: narrow && !showList ? "none" : "flex",
          borderRight: narrow ? "none" : "1px solid var(--hair)",
          background: "var(--tile)",
          flexDirection: "column",
          padding: 24,
          gap: 20,
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <BackButton onClick={onClose} />
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700 }}>Settings</h1>
        </div>
        <nav
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
          aria-label="Settings pages"
        >
          {PAGES.map((p) => {
            const selected = p.key === page;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => {
                  setPage(p.key);
                  setShowList(false);
                }}
                aria-current={selected ? "page" : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "10px 12px",
                  background: selected ? "var(--nest)" : "transparent",
                  border: selected ? "1px solid var(--hair-2)" : "1px solid transparent",
                  borderRadius: 12,
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 9,
                    background: p.tint,
                    color: "var(--bg)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <Icon name={p.icon} s={19} sw={2} />
                </span>
                <span
                  style={{ fontFamily: "var(--ui)", fontSize: 16, color: "var(--ink)", flex: 1 }}
                >
                  {p.label}
                </span>
                <span style={{ color: "var(--ink-3)" }}>
                  <Icon name="chevron" s={16} />
                </span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Content , the only pane once a page is picked on a phone. The generous
          64px side padding is panel framing; on a 440px viewport it would eat
          almost a third of the width, so it tightens to 20px. Fill pages (e.g.
          Logs) own a dense full-width list, so 64px would eat directly into
          usable columns , they get a tighter 24px instead. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          // A fill page's own list is the scroller; the pane must not also
          // scroll (that double-scrollbar is exactly what `fill` fixes).
          overflowY: fill ? "hidden" : "auto",
          padding: narrow ? "20px 20px 40px" : fill ? "40px 24px 0" : "40px 64px",
          display: narrow && showList ? "none" : fill ? "flex" : "block",
          flexDirection: fill ? "column" : undefined,
        }}
      >
        <div
          style={{
            // Fill pages span the full width and height they are given; other
            // pages sit in the centered, capped reading column.
            maxWidth: fill ? "none" : 720,
            width: "100%",
            margin: fill ? undefined : "0 auto",
            display: "flex",
            flexDirection: "column",
            gap: 28,
            ...(fill ? { flex: 1, minHeight: 0 } : {}),
          }}
        >
          {/* Back to the page list , the only way out of a page on a phone,
              where the sidebar it would otherwise return to is hidden. */}
          {narrow ? (
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <BackButton onClick={() => setShowList(true)} />
              <span style={{ fontSize: 17, fontWeight: 600 }}>Settings</span>
            </div>
          ) : null}
          <PageHeader title={active.label} blurb={active.blurb} />
          {ActivePage ? (
            fill ? (
              // Give the fill page a definite height so its `height:100%` list
              // resolves against real pixels instead of collapsing to auto.
              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                <ActivePage onClose={onClose} onOpenLevel={onOpenLevel} onOpenClean={onOpenClean} />
              </div>
            ) : (
              <ActivePage onClose={onClose} onOpenLevel={onOpenLevel} onOpenClean={onOpenClean} />
            )
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
