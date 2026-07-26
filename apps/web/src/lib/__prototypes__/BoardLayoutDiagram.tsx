/**
 * Overnight design exploration for issue #68 ("tile layout too right-heavy,
 * gap between photo booth and guest wifi"). NOT part of the app , a throwaway
 * scaled-down diagram of the board's real tile-registry world coordinates
 * (via grid-constants' tileWorldRect, the same math Board.tsx uses), with the
 * resting-viewport (the 12x9-cell window the board opens/idles on, centered
 * on HOME_TILE per Board.tsx L425-435) drawn as an accent outline so the
 * "too far right" / "gap above the view" claims are visible at a glance
 * instead of asserted.
 *
 * Real registry data in, real grid math in, labeled boxes out , no fabricated
 * tile content, this never renders as (or is mistaken for) the live board.
 */

import { BOARD_H, BOARD_W, tileWorldRect } from "@/lib/grid-constants";

export type DiagramTile = {
  id: string;
  label: string;
  col: number;
  row: number;
  cols: number;
  rows: number;
};

interface BoardLayoutDiagramProps {
  tiles: DiagramTile[];
  homeId: string;
  /** World-px-to-screen-px scale. 0.16 comfortably fits the ~4700px world at board size. */
  scale?: number;
}

export function BoardLayoutDiagram({ tiles, homeId, scale = 0.16 }: BoardLayoutDiagramProps) {
  const home = tiles.find((t) => t.id === homeId);
  if (!home) return null;
  const homeRect = tileWorldRect({
    worldCol: home.col,
    worldRow: home.row,
    cols: home.cols,
    rows: home.rows,
  });
  const homeCx = homeRect.x + homeRect.w / 2;
  const homeCy = homeRect.y + homeRect.h / 2;
  const viewport = {
    x: homeCx - BOARD_W / 2,
    y: homeCy - BOARD_H / 2,
    w: BOARD_W,
    h: BOARD_H,
  };

  // Bounding box of every tile + the viewport, so the diagram frames tightly
  // instead of showing the whole 4700px pannable world.
  const rects = tiles.map((t) => ({
    id: t.id,
    label: t.label,
    ...tileWorldRect({ worldCol: t.col, worldRow: t.row, cols: t.cols, rows: t.rows }),
  }));
  const minX = Math.min(viewport.x, ...rects.map((r) => r.x)) - 40;
  const minY = Math.min(viewport.y, ...rects.map((r) => r.y)) - 40;
  const maxX = Math.max(viewport.x + viewport.w, ...rects.map((r) => r.x + r.w)) + 40;
  const maxY = Math.max(viewport.y + viewport.h, ...rects.map((r) => r.y + r.h)) + 40;

  const toScreen = (x: number, y: number) => ({ x: (x - minX) * scale, y: (y - minY) * scale });

  return (
    <div
      style={{
        position: "relative",
        width: (maxX - minX) * scale,
        height: (maxY - minY) * scale,
        background: "var(--bg)",
        overflow: "hidden",
      }}
    >
      {/* Resting-viewport outline , what the panel actually shows at rest. */}
      {(() => {
        const p = toScreen(viewport.x, viewport.y);
        return (
          <div
            style={{
              position: "absolute",
              left: p.x,
              top: p.y,
              width: viewport.w * scale,
              height: viewport.h * scale,
              border: "2px dashed var(--acc)",
              borderRadius: 4,
              boxSizing: "border-box",
              zIndex: 2,
              pointerEvents: "none",
            }}
          />
        );
      })()}
      {rects.map((r) => {
        const p = toScreen(r.x, r.y);
        const isHome = r.id === homeId;
        return (
          <div
            key={r.id}
            style={{
              position: "absolute",
              left: p.x,
              top: p.y,
              width: r.w * scale,
              height: r.h * scale,
              background: isHome ? "var(--acc)" : "var(--tile)",
              border: "1px solid var(--hair)",
              borderRadius: 3,
              boxSizing: "border-box",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              color: isHome ? "var(--bg)" : "var(--ink-2)",
              fontSize: 9,
              textAlign: "center",
              lineHeight: 1.1,
              padding: 1,
            }}
          >
            {r.label}
          </div>
        );
      })}
    </div>
  );
}
