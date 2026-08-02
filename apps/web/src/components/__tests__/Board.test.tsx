import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// A fake one-tile registry so Board can be exercised without loading real tiles
// (or their transitive deps like maplibre-gl) in jsdom. The fake tile renders an
// inner button so we can prove control taps don't open the detail page.
vi.mock("@features/_generated/web.gen", () => {
  const fake = {
    id: "tile_fake",
    label: "Fake Tile",
    component: () => (
      <div>
        tile-body
        <button type="button">inner-control</button>
      </div>
    ),
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
    getTileDetailEntry: (id: string) =>
      id === "tile_fake"
        ? {
            kind: "page" as const,
            tileId: "tile_fake",
            title: "Fake Tile",
            defaultSlug: "v1",
            useVariants: () => ({
              loading: false,
              variants: [
                {
                  slug: "v1",
                  label: "V1",
                  render: () => <div data-testid="fake-detail">fake-detail-content</div>,
                },
              ],
            }),
          }
        : undefined,
  };
});
vi.mock("../ConnectionLostBanner", () => ({ ConnectionLostBanner: () => null }));
vi.mock("../DevOverlayHud", () => ({ DevOverlayHud: () => null }));

import { closeTileDetail } from "../../lib/tile-detail-store";
import { Board } from "../Board";

afterEach(() => {
  cleanup();
  // The tile-detail store is module-global; drain it so an open page from one
  // test can't leak into the next.
  closeTileDetail();
  vi.restoreAllMocks();
});

describe("Board", () => {
  it("renders a #stage element", () => {
    render(<Board />);
    expect(document.getElementById("stage")).not.toBeNull();
  });

  it("renders the pannable #world inside #stage", () => {
    render(<Board />);
    const stage = document.getElementById("stage");
    const world = document.getElementById("world");
    expect(world).not.toBeNull();
    expect(stage?.contains(world ?? null)).toBe(true);
  });

  it("tapping a tile opens its detail page", () => {
    render(<Board />);
    expect(screen.queryByTestId("fake-detail")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open Fake Tile" }));

    expect(screen.getByTestId("fake-detail").textContent).toContain("fake-detail-content");
  });

  it("tapping an inner control does NOT open the detail page", () => {
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "inner-control" }));
    expect(screen.queryByTestId("fake-detail")).toBeNull();
  });
});
