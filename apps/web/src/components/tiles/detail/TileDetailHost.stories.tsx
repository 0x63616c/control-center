/**
 * Stories for TileDetailHost , the full-page tile detail shell. Driven by
 * fixture entries (stories may use fixtures; the zero-fake-data rule applies to
 * app runtime wiring): a single-variant page (switcher hidden), a multi-variant
 * page (switcher visible, swapping works), and a PIN-gated page (gate first).
 *
 * The real host resolves entries from the detail registry, which only carries
 * live-wired tiles , so these stories mount the exported GatedTileDetail with a
 * fixture entry, gated on the tile-detail-store so open/close behaves like the
 * app: an effect calls openTileDetail, and BackButton/Escape close for real.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { __resetSessionForTests } from "../../../lib/panel-session";
import { setPinCode } from "../../../lib/settings";
import { closeTileDetail, openTileDetail, useTileDetail } from "../../../lib/tile-detail-store";
import { modalDocsParameters } from "../__stories__/factory";
import { GatedTileDetail } from "./TileDetailHost";
import type { DetailVariant, TileDetailPageEntry } from "./types";

// ─── fixtures ─────────────────────────────────────────────────────────────────

// Plain content blocks standing in for real variant bodies , enough structure
// to show the header, scroll region, and the 920px content cap convention.
function FixtureBody({ heading }: { heading: string }) {
  return (
    <div style={{ maxWidth: 920, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 20 }}>{heading}</h2>
      <div
        style={{
          height: 260,
          borderRadius: 16,
          border: "1px solid var(--hair)",
          background: "var(--tile)",
        }}
      />
    </div>
  );
}

function variant(slug: string, label: string): DetailVariant {
  return { slug, label, render: () => <FixtureBody heading={label} /> };
}

const singleEntry: TileDetailPageEntry = {
  kind: "page",
  tileId: "tile_weath",
  title: "Single Variant",
  defaultSlug: "detail",
  useVariants: () => ({ variants: [variant("detail", "Detail")], loading: false }),
};

const multiEntry: TileDetailPageEntry = {
  kind: "page",
  tileId: "tile_ctrl",
  title: "Multi Variant",
  defaultSlug: "first",
  useVariants: () => ({
    variants: [variant("first", "First"), variant("second", "Second"), variant("third", "Third")],
    loading: false,
  }),
};

const pinEntry: TileDetailPageEntry = {
  kind: "page",
  tileId: "tile_wakes",
  title: "Gated Page",
  defaultSlug: "detail",
  useVariants: () => ({ variants: [variant("detail", "Behind the gate")], loading: false }),
};

// ─── harness ──────────────────────────────────────────────────────────────────

// Store-gated mount, mirroring how Board.tsx hosts the real TileDetailHost: an
// effect opens the detail, and the page unmounts when BackButton/Escape write
// null back to the store. A "Reopen" button makes the story replayable.
function StoreDrivenDetail({ entry }: { entry: TileDetailPageEntry }) {
  const target = useTileDetail();
  useEffect(() => {
    openTileDetail(entry.tileId);
    return () => closeTileDetail();
  }, [entry.tileId]);
  return (
    <>
      <button type="button" onClick={() => openTileDetail(entry.tileId)}>
        Reopen
      </button>
      {target?.tileId === entry.tileId && (
        <GatedTileDetail key={entry.tileId} entry={entry} initialSlug={target.variantSlug} />
      )}
    </>
  );
}

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Detail/TileDetailHost",
  component: StoreDrivenDetail,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
} satisfies Meta<typeof StoreDrivenDetail>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── stories ──────────────────────────────────────────────────────────────────

/** One variant: full page with header + BackButton, no floating switcher. */
export const SingleVariant: Story = {
  name: "Single variant , switcher hidden",
  args: { entry: singleEntry },
};

/** Three variants: the floating VariantSwitcher pill bar swaps the body live. */
export const MultiVariant: Story = {
  name: "Multi variant , switcher visible",
  args: { entry: multiEntry },
};

/**
 * sensitive entry: the PIN gate shows first (decorator pins the code to 000000 ,
 * tap 0 six times, and relocks the session so the gate always shows); the page
 * mounts only after a correct entry, and cancelling the gate closes the detail
 * entirely.
 */
export const PinGated: Story = {
  name: "PIN gated , gate before page",
  args: { entry: pinEntry },
  decorators: [
    (Story) => {
      setPinCode("000000");
      // panel-session is a singleton; relock it so a previous story's unlock
      // doesn't skip the gate.
      __resetSessionForTests();
      return <Story />;
    },
  ],
};
