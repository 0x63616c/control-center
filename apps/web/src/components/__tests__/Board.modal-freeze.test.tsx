import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "../ui/Modal";

// A tile that manages its OWN modal in its React subtree, opened by an inner
// button (a control tap via INTERACTIVE_SELECTOR). The modal portals to
// <body>, but in the React tree it is a descendant of the board's tile wrapper,
// so React replays its events up into the board. The modal holds a button so we
// can click "inside the modal" and assert the board does not move behind it.
function SelfModalTile() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      tile-body
      <button type="button" onClick={() => setOpen(true)}>
        open-self-modal
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Self Modal">
        <button type="button">modal-action</button>
      </Modal>
    </div>
  );
}

vi.mock("@features/_generated/web.gen", () => {
  const self = {
    id: "tile_self",
    label: "Self Tile",
    component: SelfModalTile,
    viewComponent: () => null,
    worldCol: 26,
    worldRow: 27,
    cols: 4,
    rows: 2,
    home: true,
    access: { requiresSessionUnlock: false, requiresFreshUnlock: false },
  };
  return {
    TILE_REGISTRY: [self],
    HOME_TILE: self,
    accessFor: () => self.access,
    registryEntryForTileId: (id: string) => (id === self.id ? self : undefined),
    getTileDetailEntry: () => undefined,
  };
});
vi.mock("../ConnectionLostBanner", () => ({ ConnectionLostBanner: () => null }));
vi.mock("../DevOverlayHud", () => ({ DevOverlayHud: () => null }));

import { Board } from "../Board";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Board , pan freeze while a tile's own modal is open", () => {
  it("a click inside an open modal does NOT scroll the board behind it", () => {
    render(<Board />);
    const stage = document.getElementById("stage");
    if (!stage) throw new Error("stage missing");
    // jsdom has no scrollTo; install one so glideToTile takes the smooth-scroll
    // path (browser behavior) and spy to detect any programmatic glide.
    stage.scrollTo = () => {};
    const scrollSpy = vi.spyOn(stage, "scrollTo");

    // Open the tile's own modal. (Opening is allowed to recenter , we only care
    // about what happens AFTER it is open.)
    fireEvent.click(screen.getByRole("button", { name: "open-self-modal" }));
    expect(screen.getByRole("button", { name: "modal-action" })).toBeTruthy();

    scrollSpy.mockClear();

    // Click a control INSIDE the open modal. The board must stay frozen , no
    // glide/scroll behind the backdrop.
    fireEvent.click(screen.getByRole("button", { name: "modal-action" }));

    expect(scrollSpy).not.toHaveBeenCalled();
  });
});
