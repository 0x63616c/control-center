/**
 * Shared types for the tap-to-open tile detail PAGES (full-page overlays).
 *
 * Successor to the deleted modal-era types (LiveVariant et al): a tile's detail
 * variants are bare page bodies now , no <Modal> chrome, no open/onClose ,
 * hosted by TileDetailHost, which supplies the page shell (portal, header,
 * BackButton) and the floating VariantSwitcher. All variants are fed LIVE tRPC
 * data by the wiring hook , never fixtures (the repo's zero-fake-data rule
 * applies to app runtime).
 */

import type { ReactNode } from "react";

export interface DetailVariant {
  /** Stable id, kebab-case , matches the old modal variant slugs. */
  slug: string;
  /** Short human label shown in the floating switcher. */
  label: string;
  /**
   * Accent dot on this variant's switcher pill , attention-worthy live state
   * (a done timer, a firing alarm) that must stay visible while the user is on
   * ANOTHER variant of the open page. Unset/false renders no dot.
   */
  badge?: boolean;
  /** Renders the variant's bare page content , NO <Modal>. */
  render: () => ReactNode;
}

export interface TileDetailPageEntry {
  kind: "page";
  /** Matches the board tile id, e.g. "tile_tesla". */
  tileId: string;
  /** Header title, matches the tile label. */
  title: string;
  /**
   * Sensitive (Activity): the host runs PinGateModal before the page mounts,
   * unless the panel session is already unlocked. A correct PIN unlocks the
   * whole session (panel-session), so re-opening a sensitive page within the
   * same session skips the gate , see TileDetailHost.
   */
  sensitive?: true;
  /**
   * Page shell chrome. Default (`"header"`, or unset) gives the standard sticky
   * PageHeader + padded scroll region every tile detail uses. `"none"` drops
   * both , the host renders the variant edge-to-edge (full-bleed) and the page
   * owns its own chrome (e.g. the photo-booth camera is full-bleed; its gallery
   * renders its own PageHeader). Safe-area padding is kept either way.
   */
  chrome?: "header" | "none";
  /** Default variant slug shown first when the tile is tapped. */
  defaultSlug: string;
  /**
   * Live-data hook, called only while the page is open (active-only child, so
   * hooks rules hold and closed tiles never run their queries).
   */
  useVariants: () => { variants: DetailVariant[]; loading: boolean };
}

export interface TileDetailActionEntry {
  kind: "action";
  /** Matches the board tile id, e.g. "tile_felogs". */
  tileId: string;
  /** Runs instead of opening a page, e.g. Frontend Logs → openSettings("logs"). */
  run: () => void;
}
