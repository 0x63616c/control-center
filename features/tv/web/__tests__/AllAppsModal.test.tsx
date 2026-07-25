/**
 * Tests for AllAppsModal (www-51hf.22).
 *
 * A27: Searchable full-color grid of real source_list apps;
 *      currently-open app is marked; tapping launches it.
 *      Bare detail page body now , no <Modal> chrome.
 * A32: co-located test + stories.
 */
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AllAppsModalProps } from "../AllAppsModal";
import { AllAppsModal, cellsToFillHeight } from "../AllAppsModal";

afterEach(cleanup);

const baseProps: AllAppsModalProps = {
  apps: ["Netflix", "Disney+", "Hulu", "Apple TV+", "YouTube", "Spotify"],
  currentApp: "Netflix",
  onLaunchApp: vi.fn(),
};

describe("AllAppsModal (A27)", () => {
  it("renders all apps", () => {
    render(<AllAppsModal {...baseProps} />);
    for (const app of baseProps.apps) {
      expect(screen.getByText(app)).toBeInTheDocument();
    }
  });

  it("renders a search input", () => {
    render(<AllAppsModal {...baseProps} />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("filters apps when search text is entered", () => {
    render(<AllAppsModal {...baseProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "net" } });
    expect(screen.getByText("Netflix")).toBeInTheDocument();
    expect(screen.queryByText("Disney+")).not.toBeInTheDocument();
  });

  it("calls onLaunchApp when an app is clicked", () => {
    const onLaunchApp = vi.fn();
    render(<AllAppsModal {...baseProps} onLaunchApp={onLaunchApp} />);
    fireEvent.click(screen.getByText("Disney+"));
    expect(onLaunchApp).toHaveBeenCalledWith("Disney+");
  });

  it("marks the current app as active", () => {
    const { container } = render(<AllAppsModal {...baseProps} />);
    // Current app should have a visual active indicator
    expect(container.querySelector("[data-active-app]")).toBeInTheDocument();
  });

  it("renders the logo plate without an outline (www-huq3)", () => {
    render(<AllAppsModal {...baseProps} />);
    const plate = screen.getByLabelText("Launch Netflix").querySelector("div");
    expect(plate).not.toBeNull();
    // Assert on the raw style attribute: jsdom's CSSOM silently drops var()
    // shorthands, so plate.style.border would read "" even when a border is set.
    expect(plate?.getAttribute("style") ?? "").not.toMatch(/(^|;)\s*border:/);
  });

  it("renders marks at 34px (www-l2zg)", () => {
    // Unbranded app → glyph fallback whose fontSize is size * 0.6.
    render(<AllAppsModal {...baseProps} apps={[...baseProps.apps, "Zelda FM"]} />);
    const glyph = screen.getByLabelText("Launch Zelda FM").querySelector("div span");
    expect(glyph).toHaveStyle({ fontSize: `${34 * 0.6}px` });
  });
});

describe("cellsToFillHeight (#66)", () => {
  it("falls back to the pre-measurement row count when unmeasured", () => {
    // 6 rows of 4 , matches the old fixed-viewport design, used only until a
    // real measurement lands.
    expect(cellsToFillHeight(0)).toBe(24);
    expect(cellsToFillHeight(-10)).toBe(24);
  });

  it("scales up for a small measured height", () => {
    // 300px viewport , CELL_H=92, GRID_GAP=10 → ceil((300+10)/102) = 4 rows.
    expect(cellsToFillHeight(300)).toBe(16);
  });

  it("scales up for a realistic full TileDetailHost content-region height", () => {
    // ~860px , the real host region (panel minus header/padding) is taller
    // than the old fixed 24-cell design accounted for, so this must exceed 24.
    const cells = cellsToFillHeight(860);
    expect(cells).toBeGreaterThan(24);
    expect(cells % 4).toBe(0);
  });
});

describe("AllAppsModal , flex-fill grid viewport (#66, was www-cb57)", () => {
  // The jsdom-default (unmeasured) fallback , single source of truth is the
  // component's own cellsToFillHeight, not a re-duplicated constant here.
  const UNMEASURED_CELLS = cellsToFillHeight(0);

  function cellCount(container: HTMLElement): number {
    const apps = container.querySelectorAll("button[aria-label^='Launch ']").length;
    const placeholders = container.querySelectorAll("[data-testid='app-placeholder']").length;
    return apps + placeholders;
  }

  it("keeps the cell count constant when search filters the grid", () => {
    const { container } = render(<AllAppsModal {...baseProps} />);
    expect(cellCount(container)).toBe(UNMEASURED_CELLS);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "net" } });
    expect(cellCount(container)).toBe(UNMEASURED_CELLS);
  });

  it("fills the grid with placeholder tiles when nothing matches", () => {
    const { container } = render(<AllAppsModal {...baseProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "zzz no match" } });
    expect(container.querySelectorAll("[data-testid='app-placeholder']")).toHaveLength(
      UNMEASURED_CELLS,
    );
    expect(screen.queryByText(/no apps match/i)).not.toBeInTheDocument();
  });

  it("flex-fills the host's content region instead of pinning a height", () => {
    const { container } = render(<AllAppsModal {...baseProps} />);
    const viewport = container.querySelector("[data-testid='apps-grid-viewport']");
    expect(viewport).not.toBeNull();
    const style = (viewport as HTMLElement).style;
    // flex:1/minHeight:0 is what lets the viewport match whatever height the
    // real TileDetailHost content region gives it (#66), instead of a pinned
    // px height that leaves dead space below the grid.
    expect(style.flex).toBe("1 1 0%");
    expect(style.minHeight).toBe("0px");
    expect(style.overflowY).toBe("auto");
  });

  it("does not pad with placeholders beyond a full viewport of real apps", () => {
    const manyApps = Array.from({ length: 30 }, (_, i) => `App ${i + 1}`);
    const { container } = render(<AllAppsModal {...baseProps} apps={manyApps} />);
    expect(container.querySelectorAll("[data-testid='app-placeholder']")).toHaveLength(0);
  });

  describe("with a measured (tall) viewport", () => {
    let originalClientHeight: PropertyDescriptor | undefined;
    const TALL_HEIGHT = 860;

    class FakeResizeObserver {
      observe() {}
      disconnect() {}
    }

    beforeEach(() => {
      originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        value: TALL_HEIGHT,
      });
      vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    });

    afterEach(() => {
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
      }
      vi.unstubAllGlobals();
    });

    it("scales placeholder padding with the measured height, not a fixed 24, even under search filtering", () => {
      // The exact regression scenario: a tall (now flex-filled) viewport
      // narrowed by search to a handful of matches must still pad to the
      // TALL_HEIGHT cell count, not the old fixed 24.
      const { container } = render(<AllAppsModal {...baseProps} />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "net" } });
      expect(cellCount(container)).toBe(cellsToFillHeight(TALL_HEIGHT));
      expect(cellCount(container)).not.toBe(UNMEASURED_CELLS);
    });
  });
});
