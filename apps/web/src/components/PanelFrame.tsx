/**
 * PanelFrame , caps the web app to the wall panel's own resolution
 * (1366x1024) and, on a desktop browser with room to spare, draws it inside a
 * centered iPad-style device frame instead of letting the board stretch to
 * fill the window.
 *
 * Why this exists: "Fixed wall panel, 1366x1024, not responsive" was only
 * ever true for the native/Capacitor kiosk shell and the physical panel
 * hardware, where the OS constrains the viewport. The deployed WEB app had no
 * cap , Board.tsx's stage is `position:fixed;inset:0` (full window) by
 * design (see grid-constants.ts), so a desktop browser simply showed more of
 * the pannable world, while Modal.tsx separately clamped its own dialogs to
 * 1366x1024. That mismatch (board stretches, modals don't) is what this fixes.
 *
 * How the cap works: `panelStyle` below gives the 1366x1024 box a `transform`,
 * which per the CSS Transforms spec makes it the *containing block* for every
 * `position:fixed` descendant in the tree , including Board's own stage and
 * everything Board renders inside it (FPS meter, minimap, banners). Nothing in
 * Board.tsx, Modal.tsx, or grid-constants.ts changes; a fixed-position child
 * three levels down just starts resolving `inset:0` against this 1366x1024 box
 * instead of the browser viewport. The one thing this can't reach is a
 * `createPortal(..., document.body)` target (Modal's backdrop, DimOverlay) ,
 * those still cover the true browser window. In practice that reads fine: the
 * frame and the portal's flex-centering both center on the same point, so a
 * modal still opens in the right visual place; only its dimming veil bleeds
 * past the bezel into the surrounding desktop. Documented, not silently
 * papered over.
 *
 * Native passthrough: on Capacitor (the kiosk shell) this renders `children`
 * completely unwrapped , no extra DOM node, no transform, no behavior change.
 * The physical panel and the native build are untouched by this file.
 */

import { Capacitor } from "@capacitor/core";
import { type CSSProperties, type ReactNode, useSyncExternalStore } from "react";

// The physical wall panel's resolution. Intentionally NOT imported from
// grid-constants , BOARD_W there is this same 1366, but BOARD_H is 1000 (a
// pre-existing, unrelated drift used only for grid cell math; see the comment
// on BOARD_H). This frame names the real device size the docs/product use
// everywhere else, not the grid's internal math.
const PANEL_WIDTH = 1366;
const PANEL_HEIGHT = 1024;

// Minimum air (px) required on BOTH axes before the bezel bothers rendering.
// Below this a "frame" would be a sliver, not a device , the panel just fills
// the window unframed like it does today, still capped by the transform trick
// above so it never stretches.
const MIN_BEZEL_MARGIN = 24;

function subscribe(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

// Tracks the real browser viewport (not the capped panel size) purely to
// decide whether there's room to draw the bezel. useSyncExternalStore (not a
// resize-listener useEffect) so this never desyncs from the actual window
// during React's concurrent rendering.
function useViewportSize() {
  const width = useSyncExternalStore(
    subscribe,
    () => window.innerWidth,
    () => PANEL_WIDTH,
  );
  const height = useSyncExternalStore(
    subscribe,
    () => window.innerHeight,
    () => PANEL_HEIGHT,
  );
  return { width, height };
}

const outerStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#000000",
  overflow: "hidden",
};

// Sized wrapper the bezel decorates. Deliberately NOT the element that clips
// content (see panelStyle below) so the bezel's own box-shadow can extend
// outward from the 1366x1024 edge without being cut off by that clip.
const frameStyle: CSSProperties = {
  position: "relative",
  width: PANEL_WIDTH,
  height: PANEL_HEIGHT,
  flex: "0 0 auto",
};

// The transform is what turns this into a containing block for `position:
// fixed` descendants (see file header) , translate3d(0,0,0) is the smallest
// no-op transform that still counts for that purpose.
const panelStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  overflow: "hidden",
  transform: "translate3d(0, 0, 0)",
  background: "var(--bg)",
};

// A restrained iPad-style bezel: a dark metal surround with a hairline edge
// and a single top-center camera dot, evoking a real device without trying to
// photorealistically render one. Pointer-events none , it's a decorative
// sibling layered OVER the panel's own edges, never a hit target.
function Bezel() {
  const bezelStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    borderRadius: 34,
    boxShadow: [
      "0 0 0 14px #161616",
      "0 0 0 15px rgba(255, 255, 255, 0.06)",
      "0 40px 90px -20px rgba(0, 0, 0, 0.8)",
    ].join(", "),
    pointerEvents: "none",
  };
  const cameraStyle: CSSProperties = {
    position: "absolute",
    top: -8,
    left: "50%",
    transform: "translateX(-50%)",
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "#2a2a2a",
    boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.08)",
    pointerEvents: "none",
  };
  return (
    <>
      <div style={bezelStyle} />
      <div style={cameraStyle} />
    </>
  );
}

export function PanelFrame({ children }: { children: ReactNode }) {
  const { width, height } = useViewportSize();

  // Native kiosk shell: the OS already constrains the viewport to the panel's
  // own resolution and there's no desktop chrome to frame it against.
  // Unwrapped passthrough keeps the native build byte-for-byte unaffected.
  if (Capacitor.isNativePlatform()) return <>{children}</>;

  const hasRoom =
    width - PANEL_WIDTH >= MIN_BEZEL_MARGIN && height - PANEL_HEIGHT >= MIN_BEZEL_MARGIN;

  return (
    <div style={outerStyle}>
      <div style={frameStyle}>
        <div style={panelStyle} data-testid="panel-frame-canvas">
          {children}
        </div>
        {hasRoom ? <Bezel /> : null}
      </div>
    </div>
  );
}
