import { describe, expect, it } from "vitest";
import { createWebRegistry } from "./web-runtime";

const TileFace = () => null;
const TileView = () => null;
const detail = { kind: "page" as const, tileId: "tile_clock" };

describe("createWebRegistry", () => {
  it("builds Board and Tile View lookup from one App aggregate", () => {
    const registry = createWebRegistry(
      [
        {
          id: "app_clock",
          tiles: [
            {
              id: "tile_clock",
              label: "Clock",
              component: TileFace,
              viewComponent: TileView,
              worldCol: 1,
              worldRow: 2,
              cols: 3,
              rows: 4,
              home: true,
            },
          ],
        },
      ],
      [detail],
    );

    expect(registry.HOME_TILE.id).toBe("tile_clock");
    expect(registry.registryEntryForComponent(TileFace)?.id).toBe("tile_clock");
    expect(registry.registryEntryForTileId("tile_clock")?.label).toBe("Clock");
    expect(registry.getTileDetailEntry("tile_clock")).toBe(detail);
  });
});
