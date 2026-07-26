/**
 * Overnight design exploration for issue #69 ("the photobooth home tile
 * sucks"). NOT wired into the board or the tile registry , these are
 * throwaway variants of the 2x2 board face, built from the same real `ui/`
 * primitives (Tile, TileHeader, Icon) as the shipped PhotoBoothTile, framed at
 * its true 2x2 wall size via the same tilePixelSize() math the BoardDecorator
 * uses for registry-backed tiles (registryEntryForComponent can't resolve
 * these standalone components, so the frame is built by hand here).
 *
 * No fake data: the booth carries no live board state today (see the shipped
 * component's comment), so every variant stays purely decorative , no
 * fabricated counts, timestamps, or thumbnails.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Icon } from "@/components/Icon";
import { Tile, TileHeader } from "@/components/ui";
import { tilePixelSize } from "@/lib/grid-constants";

// ─── Framing ──────────────────────────────────────────────────────────────────

function BoothFrame({ children }: { children: React.ReactNode }) {
  const { width, height } = tilePixelSize(2, 2);
  return (
    <div
      className="e-root"
      style={{ width, height, display: "flex", flexDirection: "column", background: "var(--bg)" }}
    >
      {children}
    </div>
  );
}

// ─── Variant A: Viewfinder , camera icon inside HUD corner brackets ───────────
// A camera-viewfinder motif (4 accent corner brackets) instead of a plain
// rounded-square nest. Reads more "camera app", less "generic icon tile".

function PhotoBoothTileViewfinder() {
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
        <div style={{ position: "relative", width: 76, height: 76 }}>
          {(["tl", "tr", "bl", "br"] as const).map((corner) => {
            const size = 18;
            const style: React.CSSProperties = {
              position: "absolute",
              width: size,
              height: size,
              borderColor: "var(--acc)",
              borderStyle: "solid",
              borderWidth: 0,
              opacity: 0.9,
            };
            if (corner === "tl") {
              style.top = 0;
              style.left = 0;
              style.borderTopWidth = 2.5;
              style.borderLeftWidth = 2.5;
              style.borderTopLeftRadius = 6;
            }
            if (corner === "tr") {
              style.top = 0;
              style.right = 0;
              style.borderTopWidth = 2.5;
              style.borderRightWidth = 2.5;
              style.borderTopRightRadius = 6;
            }
            if (corner === "bl") {
              style.bottom = 0;
              style.left = 0;
              style.borderBottomWidth = 2.5;
              style.borderLeftWidth = 2.5;
              style.borderBottomLeftRadius = 6;
            }
            if (corner === "br") {
              style.bottom = 0;
              style.right = 0;
              style.borderBottomWidth = 2.5;
              style.borderRightWidth = 2.5;
              style.borderBottomRightRadius = 6;
            }
            return <div key={corner} style={style} />;
          })}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
            }}
          >
            <Icon name="camera" s={32} c="var(--ink)" sw={1.6} />
          </div>
        </div>
      </div>
    </Tile>
  );
}

// ─── Variant B: Photo stack , offset blank cards behind the camera badge ──────
// Hints at "this opens a gallery" with a stack of blank, rotated photo-card
// silhouettes (no fabricated thumbnails , just the card shape), camera badge
// overlapping the bottom-right corner of the stack.

function PhotoBoothTileStack() {
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

// ─── Variant C: Aperture ring , large accent ring, caption on the nest ────────
// A bigger, bolder mark: a thin accent aperture ring around the camera glyph,
// plus a small quiet caption ("Tap to open") so the tile explains itself at a
// glance, matching the caption pattern other tiles use for a secondary line.

function PhotoBoothTileAperture() {
  return (
    <Tile padding={22}>
      <TileHeader icon="camera" title="Photo Booth" />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
        }}
      >
        <div
          style={{
            width: 68,
            height: 68,
            borderRadius: "50%",
            border: "2px solid var(--acc)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <div
            style={{
              width: 46,
              height: 46,
              borderRadius: "50%",
              background: "var(--nest)",
              display: "grid",
              placeItems: "center",
            }}
          >
            <Icon name="camera" s={24} c="var(--ink)" sw={1.6} />
          </div>
        </div>
        <span style={{ fontSize: 12, color: "var(--ink-2)", letterSpacing: "var(--track-title)" }}>
          Tap to open
        </span>
      </div>
    </Tile>
  );
}

// ─── Meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Tiles/PhotoBooth/Redesign (issue-69 prototypes)",
  tags: ["autodocs"],
  parameters: { boardWrapper: false },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const AViewfinder: Story = {
  render: () => (
    <BoothFrame>
      <PhotoBoothTileViewfinder />
    </BoothFrame>
  ),
};

export const BPhotoStack: Story = {
  render: () => (
    <BoothFrame>
      <PhotoBoothTileStack />
    </BoothFrame>
  ),
};

export const CApertureRing: Story = {
  render: () => (
    <BoothFrame>
      <PhotoBoothTileAperture />
    </BoothFrame>
  ),
};
