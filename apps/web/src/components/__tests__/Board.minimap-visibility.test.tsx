import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORLD_H, WORLD_W } from "../../lib/grid-constants";

// Same lightweight stubs as Board.idle.test.tsx so the REAL Board mounts in
// jsdom. This suite pins WHEN the minimap (and centered-tile label) may appear:
// only on user-initiated viewport movement. Programmatic navigation , the
// idle-reset glide home and the mount centering , must never show them
// (www-5teu: the wall panel flashed the minimap every time it idled back to the
// clock).
vi.mock("@features/_generated/web.gen", () => {
  const fake = {
    id: "tile_fake",
    label: "Fake Tile",
    component: () => <div>tile-body</div>,
    viewComponent: () => null,
    worldCol: 26,
    worldRow: 27,
    cols: 4,
    rows: 2,
    home: true,
    access: { requiresSessionUnlock: false, requiresFreshUnlock: false },
  };
  return {
    TILE_REGISTRY: [fake],
    HOME_TILE: fake,
    accessFor: () => fake.access,
    registryEntryForTileId: (id: string) => (id === fake.id ? fake : undefined),
    getTileDetailEntry: () => undefined,
  };
});
vi.mock("../ConnectionLostBanner", () => ({ ConnectionLostBanner: () => null }));
vi.mock("../DevOverlayHud", () => ({ DevOverlayHud: () => null }));

import { resetSettings, setShowMinimap } from "../../lib/settings";
import { Board } from "../Board";

const CLIENT_W = 1366;
const CLIENT_H = 1024;

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return this.id === "stage" ? CLIENT_W : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.id === "stage" ? CLIENT_H : 0;
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
  resetSettings();
});

// scrollTo is the channel programmatic navigation uses; let the writes through
// (so isHome() reflects position) without jsdom throwing on the missing API.
function stubScrollTo(stage: HTMLElement) {
  stage.scrollTo = ((opts: ScrollToOptions) => {
    if (opts && typeof opts.left === "number" && typeof opts.top === "number") {
      stage.scrollLeft = opts.left;
      stage.scrollTop = opts.top;
    }
  }) as typeof stage.scrollTo;
}

// Fire a scroll event and run the Board's rAF-throttled scroll handler.
function scrollFrame(stage: HTMLElement) {
  act(() => {
    fireEvent.scroll(stage);
    vi.advanceTimersByTime(32); // > one rAF tick
  });
}

// A user pan as the panel really produces one: a touch/mouse press lands on the
// stage first (pointerdown), then scroll events stream while the finger moves.
function userPan(stage: HTMLElement, left: number, top: number) {
  fireEvent.pointerDown(stage);
  stage.scrollLeft = left;
  stage.scrollTop = top;
  scrollFrame(stage);
  fireEvent.pointerUp(stage);
}

function minimapOpacity() {
  return screen.getByTestId("minimap-root").style.opacity;
}

describe("Minimap visibility (user-initiated movement only)", () => {
  it("stays hidden through the mount-centering scroll echo", () => {
    render(<Board />);
    const stage = document.getElementById("stage") as HTMLElement;
    stubScrollTo(stage);

    // The browser fires a scroll event for the layout-effect centering write.
    scrollFrame(stage);
    expect(minimapOpacity()).toBe("0");
  });

  it("shows on a user pan, then fades ~1.5s after the last movement", () => {
    render(<Board />);
    const stage = document.getElementById("stage") as HTMLElement;
    stubScrollTo(stage);

    userPan(stage, WORLD_W / 2, WORLD_H / 2);
    expect(minimapOpacity()).toBe("1");

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(minimapOpacity()).toBe("0");
  });

  it("stays absent entirely when showMinimap is off, even on a user pan", () => {
    setShowMinimap(false);
    render(<Board />);
    const stage = document.getElementById("stage") as HTMLElement;
    stubScrollTo(stage);

    // A real user pan would normally reveal the minimap + its centered-tile
    // label; with the setting off, neither ever mounts.
    userPan(stage, WORLD_W / 2, WORLD_H / 2);
    expect(screen.queryByTestId("minimap-root")).toBeNull();
    expect(screen.queryByTestId("centered-tile-label")).toBeNull();
  });

  it("shows during the user-initiated tap-to-recenter glide", () => {
    render(<Board />);
    const stage = document.getElementById("stage") as HTMLElement;
    stubScrollTo(stage);

    // Tap the (home) tile: glideToTile recenters via smooth scrollTo. The move
    // is user-initiated, so its scroll frames must show the minimap.
    fireEvent.click(screen.getByRole("button", { name: "Open Fake Tile" }));
    scrollFrame(stage);
    expect(minimapOpacity()).toBe("1");
  });
});
