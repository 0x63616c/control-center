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
 * How the cap works (#257): a `transform` makes its element the *containing
 * block* for every `position:fixed` descendant , per the CSS Transforms
 * spec , but only for descendants still inside that element's own subtree.
 * The original version of this file put that transform on `panelStyle`, an
 * inner div. That contained Board's own stage and everything Board renders
 * inside it, but NOT the 10 components in this app that call
 * `createPortal(..., document.body)` (Modal, PinGateModal, TileDetailHost,
 * SettingsPage, DimOverlay, NotificationBanner, VariantSwitcher,
 * LevelOverlay, CleanScreenOverlay): a portal appends outside the React tree
 * entirely, so `panelStyle`'s transform was never an ancestor of that content
 * and it resolved `position:fixed` against the true browser viewport instead.
 *
 * The fix moves the transform onto `document.body` itself (an effect below,
 * not a static stylesheet rule, so it stays a no-op on native and cleans up
 * for Storybook/tests). `document.body` is an ancestor of literally
 * everything React ever mounts, portals included, so making IT the
 * containing block , sized and positioned to exactly the same 1366x1024 box
 * `panelStyle` already draws , contains every `position:fixed` descendant
 * app-wide with zero edits to any of those 10 call sites. `panelStyle`'s own
 * transform stays too (defense in depth for the React-tree case; harmless
 * once it's coincident with `body`'s box).
 *
 * The Bezel is deliberately NOT inside that clipped body box: its box-shadow
 * is designed to bleed a few px outward past the 1366x1024 edge, and
 * `body`'s new `overflow:hidden` would cut that bleed off if the Bezel were
 * a normal descendant. It's portaled instead to a sibling element appended
 * directly to `<html>`, positioned to match body's box exactly but with no
 * overflow clipping of its own.
 *
 * Native passthrough: on Capacitor (the kiosk shell) this renders `children`
 * completely unwrapped , no extra DOM node, no transform, no `document.body`
 * mutation, no behavior change. The physical panel and the native build are
 * untouched by this file.
 */

import { Capacitor } from "@capacitor/core";
import { type CSSProperties, type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

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
  const isNative = Capacitor.isNativePlatform();

  // A sibling of `document.body`, appended straight to `<html>`. This is where
  // the Bezel lives (see file header) , NOT a descendant of body, so body's
  // own `overflow: hidden` (set by the effect below) never clips its
  // box-shadow bleed. Created once per mount via lazy ref init, not state ,
  // this element is a portal TARGET, not something React itself should ever
  // re-render around.
  const bezelRootRef = useRef<HTMLDivElement | null>(null);
  if (!isNative && bezelRootRef.current === null) {
    bezelRootRef.current = document.createElement("div");
    bezelRootRef.current.setAttribute("data-panel-bezel-root", "");
  }

  // Mount/unmount only: create and attach the bezel-root sibling, and capture
  // body/html's pre-existing inline `style` attribute so it can be restored
  // byte-for-byte on cleanup , this must never leak the 1366x1024 cap into
  // Storybook stories, other routes, or a later test in the same jsdom
  // document once PanelFrame unmounts.
  useEffect(() => {
    if (isNative) return;
    const bezelRoot = bezelRootRef.current;
    if (!bezelRoot) return;

    const html = document.documentElement;
    const body = document.body;
    const prevHtmlStyle = html.getAttribute("style");
    const prevBodyStyle = body.getAttribute("style");
    html.appendChild(bezelRoot);

    return () => {
      bezelRoot.remove();
      if (prevBodyStyle === null) body.removeAttribute("style");
      else body.setAttribute("style", prevBodyStyle);
      if (prevHtmlStyle === null) html.removeAttribute("style");
      else html.setAttribute("style", prevHtmlStyle);
    };
  }, [isNative]);

  // Every resize: recompute the panel's centered position and push it onto
  // both `body` (the containing block every `position:fixed` descendant ,
  // portals included, see file header , now resolves against) and the
  // bezel-root sibling (kept pixel-perfect in sync so the Bezel still traces
  // the panel's exact edge). `transform` is what makes body a containing
  // block; translate3d(0,0,0) is the smallest no-op transform that still
  // counts for that purpose (same trick panelStyle already uses).
  useEffect(() => {
    if (isNative) return;
    const bezelRoot = bezelRootRef.current;
    if (!bezelRoot) return;

    const body = document.body;
    const left = Math.round((width - PANEL_WIDTH) / 2);
    const top = Math.round((height - PANEL_HEIGHT) / 2);

    Object.assign(body.style, {
      position: "fixed",
      left: `${left}px`,
      top: `${top}px`,
      margin: "0",
      width: `${PANEL_WIDTH}px`,
      height: `${PANEL_HEIGHT}px`,
      overflow: "hidden",
      transform: "translate3d(0, 0, 0)",
    });
    Object.assign(bezelRoot.style, {
      position: "fixed",
      left: `${left}px`,
      top: `${top}px`,
      width: `${PANEL_WIDTH}px`,
      height: `${PANEL_HEIGHT}px`,
      pointerEvents: "none",
    });
  }, [isNative, width, height]);

  // Native kiosk shell: the OS already constrains the viewport to the panel's
  // own resolution and there's no desktop chrome to frame it against.
  // Unwrapped passthrough keeps the native build byte-for-byte unaffected , no
  // body mutation, no bezel-root, nothing above this line has any effect
  // when native (both effects bail out via the `isNative` check first).
  if (isNative) return <>{children}</>;

  const hasRoom =
    width - PANEL_WIDTH >= MIN_BEZEL_MARGIN && height - PANEL_HEIGHT >= MIN_BEZEL_MARGIN;

  return (
    <>
      <div style={outerStyle}>
        <div style={frameStyle}>
          <div style={panelStyle} data-testid="panel-frame-canvas">
            {children}
          </div>
        </div>
      </div>
      {hasRoom && bezelRootRef.current ? createPortal(<Bezel />, bezelRootRef.current) : null}
    </>
  );
}
