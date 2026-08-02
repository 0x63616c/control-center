import { registryEntryForComponent } from "@features/_generated/web.gen";
import type { Decorator, Preview } from "@storybook/react-vite";
import { createElement } from "react";
import { create } from "storybook/theming/create";
import { INITIAL_VIEWPORTS } from "storybook/viewport";
import { BOARD_H, BOARD_W, tilePixelSize } from "../src/lib/grid-constants";

// Shared design layer only , tokens, fonts, keyframes, tile classes. The
// kiosk lockdown (app-shell.css) is deliberately NOT imported here, so docs
// pages scroll natively and text stays selectable inside the preview iframe.
import "../src/styles/theme.css";

// Shared dark theme for docs pages (MDX/autodocs) , keeps docs background dark.
const eveeTheme = create({
  base: "dark",
  appBg: "#060708",
  appContentBg: "#0c0e11",
  appPreviewBg: "#060708",
  appBorderColor: "rgba(255,255,255,0.06)",
  textColor: "#eef0f2",
  textMutedColor: "#9197a1",
  barSelectedColor: "#5be37d",
  colorPrimary: "#5be37d",
  colorSecondary: "#37c95e",
});

// Sizes every tile story to its exact production footprint by wrapping it in a
// fixed width×height box derived from the registry (cols/rows → pixels). Shows
// just the tile at true size , not the whole board. Non-tile stories get a
// plain dark wrapper.
const BoardDecorator: Decorator = (Story, context) => {
  if (context.parameters.boardWrapper === false) return createElement(Story);

  const entry = registryEntryForComponent(context.component);

  if (entry) {
    const { width, height } = tilePixelSize(entry.cols, entry.rows);
    return createElement(
      "div",
      {
        className: "e-root",
        style: {
          width,
          height,
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
        },
      },
      createElement(Story),
    );
  }

  // In the canvas (single-story) view, fill the dark board so the component sits
  // on the real background. On a Docs page each story renders in its OWN Canvas
  // block, so a 100vh min-height would make every block a full viewport tall ,
  // turning a tiny primitive (Pill, StatusDot, …) into a giant, super-long docs
  // page. On docs, hug the content instead (www-hljb).
  const isDocs = context.viewMode === "docs";
  return createElement(
    "div",
    {
      className: "e-root",
      style: {
        background: "var(--bg)",
        ...(isDocs ? {} : { minHeight: "100vh" }),
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "flex-start",
        padding: 20,
        boxSizing: "border-box",
      },
    },
    createElement(Story),
  );
};

const preview: Preview = {
  decorators: [BoardDecorator],
  parameters: {
    // Dark theme for MDX/autodocs pages so docs are never white.
    docs: { theme: eveeTheme },
    // Dark canvas background matching --bg token (#060708)
    backgrounds: {
      default: "board",
      values: [{ name: "board", value: "#060708" }],
    },
    // The physical wall-panel (iPad Pro 12.9" landscape), sized from the board
    // constants so it tracks the resolution automatically.
    // Storybook 10 API: `options` (not `viewports`); the initial selection lives
    // in `initialGlobals` below. The stock device presets are merged in so the
    // iPad/iPhone sizes are also available from the toolbar.
    viewport: {
      options: {
        board: {
          name: `Wall Panel · iPad Pro ${BOARD_W}×${BOARD_H}`,
          styles: { width: `${BOARD_W}px`, height: `${BOARD_H}px` },
          type: "tablet",
        },
        ...INITIAL_VIEWPORTS,
      },
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      // Flag violations in the test UI without failing CI
      test: "todo",
    },
  },
  // SB10: the initially-selected viewport lives here (replaces the old
  // viewport.defaultViewport). Boots every story at the true wall-panel size.
  initialGlobals: {
    viewport: { value: "board", isRotated: false },
  },
};

export default preview;
