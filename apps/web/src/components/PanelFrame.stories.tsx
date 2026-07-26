import type { Meta, StoryObj } from "@storybook/react-vite";
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

// Exact panel size: no slack on either axis, so no bezel , the canvas simply
// fills the window edge-to-edge, matching today's native/panel behavior.
export const ExactPanelSize: Story = {
  parameters: { viewport: { defaultViewport: "board" } },
  play: async () => {
    const doc = within(document.body);
    await expect(doc.getByTestId("panel-frame-canvas")).toBeInTheDocument();
  },
};
