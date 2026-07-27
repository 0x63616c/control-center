import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { expect, within } from "storybook/test";
import { PanelFrame } from "./PanelFrame";

// A stand-in board face , enough visual weight (grid, a fake tile) to sell
// the frame without pulling in the real Board (data/router/trpc deps a story
// shouldn't need). Fills 100% so it always exactly fills whatever PanelFrame
// gives it, same as the real board's `position:fixed;inset:0` stage does.
function FakeBoardFace() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "var(--bg)",
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gridTemplateRows: "repeat(3, 1fr)",
        gap: 18,
        padding: 18,
        boxSizing: "border-box",
      }}
    >
      {Array.from({ length: 12 }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static, order-stable decorative grid
          key={i}
          className="e-root"
          style={{
            background: "var(--tile)",
            border: "1px solid var(--hair)",
            borderRadius: "var(--r)",
          }}
        />
      ))}
      <div
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "flex-end",
          padding: 12,
          color: "var(--ink-3)",
          fontFamily: "var(--mono)",
          fontSize: 11,
        }}
      >
        {/* Deliberately position:fixed , the point of this story is proving
            PanelFrame confines a fixed-position descendant to its own
            1366x1024 box instead of the true browser viewport. */}
        fixed-position child, pinned bottom-right of the FRAME
      </div>
    </div>
  );
}

// Stands in for the 10 real components (Modal, TileDetailHost, DimOverlay,
// etc) that call `createPortal(..., document.body)` , #257's regression is
// that a portaled `position:fixed;inset:0` element resolved against the true
// browser viewport instead of the 1366x1024 panel. This renders the same
// escape hatch directly so a story can assert it's now contained.
function PortalFixedMarker() {
  // The portal CONTAINER (appended to body) is deliberately untested , it's
  // a plain, non-fixed div, so it collapses to zero size in normal flow
  // (its fixed-position child is taken out of flow). The testid , and the
  // assertion below , must target the fixed child itself, since that's the
  // element whose containing-block resolution #257 is actually about.
  const containerRef = useRef<HTMLDivElement | null>(null);
  if (containerRef.current === null) {
    containerRef.current = document.createElement("div");
  }
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    document.body.appendChild(el);
    return () => {
      el.remove();
    };
  }, []);
  return createPortal(
    <div
      data-testid="portal-fixed-marker"
      style={{ position: "fixed", inset: 0, pointerEvents: "none" }}
    />,
    containerRef.current,
  );
}

const meta = {
  title: "App/PanelFrame",
  component: PanelFrame,
  tags: ["autodocs"],
  parameters: {
    // No board-decorator wrapper , PanelFrame IS the viewport-level wrapper.
    boardWrapper: false,
    layout: "fullscreen",
    // "desktop" is this story's own addition to the global viewport set
    // (merged alongside preview.tsx's "board"); each story below selects one
    // via `viewport.defaultViewport`.
    viewport: {
      options: {
        desktop: { name: "Desktop 1920×1080", styles: { width: "1920px", height: "1080px" } },
      },
    },
  },
  args: {
    children: <FakeBoardFace />,
  },
} satisfies Meta<typeof PanelFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

// Desktop: viewport has room on both axes, so the iPad-style bezel renders
// around the capped 1366x1024 canvas. Use the toolbar's viewport picker (any
// size larger than 1366x1024 + margin) to see this live; the story itself
// asserts the frame canvas renders at exactly panel size regardless of the
// surrounding chrome.
export const Desktop: Story = {
  parameters: { viewport: { defaultViewport: "desktop" } },
  play: async () => {
    const doc = within(document.body);
    const canvas = doc.getByTestId("panel-frame-canvas");
    await expect(canvas).toBeInTheDocument();
    // The canvas is capped to the panel's own resolution regardless of the
    // much larger 1920x1080 viewport this story renders in.
    const rect = canvas.getBoundingClientRect();
    await expect(rect.width).toBe(1366);
    await expect(rect.height).toBe(1024);
  },
};

// Regression for #257: a `createPortal(..., document.body)` target , same
// escape hatch Modal, TileDetailHost, DimOverlay, etc all use , must be
// contained to the 1366x1024 panel, not the true (much larger) browser
// viewport this story renders in. Runs in a real Chromium browser (the
// "storybook" vitest project, via @storybook/addon-vitest), not jsdom, since
// jsdom does not execute real CSS layout/containing-block geometry.
export const PortalEscapeRegression: Story = {
  parameters: { viewport: { defaultViewport: "desktop" } },
  args: {
    children: (
      <>
        <FakeBoardFace />
        <PortalFixedMarker />
      </>
    ),
  },
  play: async () => {
    const doc = within(document.body);
    const marker = await doc.findByTestId("portal-fixed-marker");
    const rect = marker.getBoundingClientRect();
    // Contained within the 1366x1024 panel , exactly the size of the panel,
    // NOT the real (and here, test-runner-controlled, not necessarily
    // 1920x1080) browser viewport this story renders in. That's the whole
    // point of #257's fix: this element reached `document.body` via
    // createPortal, same as Modal/TileDetailHost/DimOverlay/etc do, and must
    // still resolve `position:fixed` against the 1366x1024 panel box.
    await expect(rect.width).toBe(1366);
    await expect(rect.height).toBe(1024);
    // The panel is centered within whatever the real viewport turns out to
    // be at test time , read it directly rather than assuming a size, since
    // the headless test browser's actual window is not guaranteed to match
    // the Storybook viewport addon's (manager-only) "desktop" preset.
    const expectedLeft = Math.round((window.innerWidth - 1366) / 2);
    const expectedTop = Math.round((window.innerHeight - 1024) / 2);
    await expect(rect.left).toBeCloseTo(expectedLeft, 0);
    await expect(rect.top).toBeCloseTo(expectedTop, 0);
    await expect(rect.right).toBeCloseTo(expectedLeft + 1366, 0);
    await expect(rect.bottom).toBeCloseTo(expectedTop + 1024, 0);
  },
};

// Exact panel size: no slack on either axis, so no bezel , the canvas simply
// fills the window edge-to-edge, matching today's native/panel behavior.
export const ExactPanelSize: Story = {
  parameters: { viewport: { defaultViewport: "board" } },
  play: async () => {
    const doc = within(document.body);
    await expect(doc.getByTestId("panel-frame-canvas")).toBeInTheDocument();
  },
};
