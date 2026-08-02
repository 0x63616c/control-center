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

  it("normalizes App access policy behind one tile lookup", () => {
    const registry = createWebRegistry(
      [
        {
          id: "app_clock",
          sensitive: true,
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
            },
          ],
        },
        {
          id: "app_booth",
          private: true,
          tiles: [
            {
              id: "tile_booth",
              label: "Booth",
              component: TileFace,
              viewComponent: TileView,
              worldCol: 5,
              worldRow: 6,
              cols: 2,
              rows: 2,
            },
          ],
        },
      ],
      [],
    );

    expect(registry.accessFor("tile_clock")).toEqual({
      requiresSessionUnlock: true,
      requiresFreshUnlock: false,
    });
    expect(registry.accessFor("tile_booth")).toEqual({
      requiresSessionUnlock: false,
      requiresFreshUnlock: true,
    });
    expect(() => registry.accessFor("tile_missing")).toThrow(/unknown Tile/);
  });

  it("rejects an App that combines session and fresh unlock policies", () => {
    expect(() =>
      createWebRegistry(
        [
          {
            id: "app_invalid",
            sensitive: true,
            private: true,
            tiles: [
              {
                id: "tile_invalid",
                label: "Invalid",
                component: TileFace,
                viewComponent: TileView,
                worldCol: 1,
                worldRow: 2,
                cols: 3,
                rows: 4,
              },
            ],
          },
        ],
        [],
      ),
    ).toThrow(/cannot be both sensitive and private/);
  });
});
