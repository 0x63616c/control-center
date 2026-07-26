import { Icon } from "@/components/Icon";
import { Tile, TileHeader } from "@/components/ui";

/**
 * PhotoBoothTile , the board face for the photo-booth feature (2x2, titled). A
 * standard TileHeader ("Photo Booth" + camera glyph) over a "photo stack" body:
 * two blank, rotated card silhouettes behind a solid card, with a small accent
 * camera badge overlapping the bottom-right corner. This hints at "this opens
 * a gallery" without fabricating any thumbnail content , the booth carries no
 * live board state today, so the body stays purely decorative (no counts,
 * timestamps, or thumbnails). No status dot for the same reason.
 *
 * Picked 2026-07-25 from three prototyped variants (issue #69, PR #153 on
 * `design/panel-layout-overnight`: viewfinder / photo-stack / aperture-ring) ,
 * photo-stack was the only one that hinted at what the tile does rather than
 * just re-skinning the icon-in-a-box shape.
 *
 * Tapping the tile opens the fullscreen camera via the board's tile-detail registry
 * (detail/wiring/photo-booth.tsx), which hosts the camera ⇄ gallery navigation.
 * The tile itself is presentational and takes no props, so it serves as both the
 * board `component` and the minimap `viewComponent` in lib/tile-registry.ts.
 *
 * The title MUST stay in sync with the registry label in lib/tile-registry.ts
 * (asserted by tile-title-sync.test.tsx).
 */
export function PhotoBoothTile() {
  return (
    <Tile padding={22}>
      <TileHeader icon="camera" title="Photo Booth" />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          display: "grid",
          placeItems: "center",
        }}
      >
        <div style={{ position: "relative", width: 84, height: 64 }}>
          <div
            style={{
              position: "absolute",
              inset: 0,
              transform: "rotate(-10deg) translate(-4px, 2px)",
              borderRadius: 10,
              background: "var(--nest)",
              border: "1px solid var(--ink-2)",
              opacity: 0.55,
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              transform: "rotate(7deg) translate(4px, -2px)",
              borderRadius: 10,
              background: "var(--nest)",
              border: "1px solid var(--ink-2)",
              opacity: 0.75,
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 10,
              background: "var(--tile)",
              border: "1px solid var(--ink-2)",
              boxShadow: "0 6px 16px -6px rgba(0,0,0,.6), inset 0 1px 0 0 rgba(255,255,255,.06)",
            }}
          />
          <div
            style={{
              position: "absolute",
              bottom: -10,
              right: -10,
              width: 38,
              height: 38,
              borderRadius: 12,
              background: "var(--acc)",
              display: "grid",
              placeItems: "center",
              boxShadow: "0 4px 12px -4px rgba(0,0,0,.5)",
            }}
          >
            <Icon name="camera" s={20} c="var(--bg)" sw={1.8} />
          </div>
        </div>
      </div>
    </Tile>
  );
}
