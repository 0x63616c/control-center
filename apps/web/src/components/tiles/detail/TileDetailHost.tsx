/**
 * TileDetailHost , the full-page shell for a tile's detail screen. Successor to
 * the deleted TileModalHost: tapping a board tile opens a Settings-style
 * body-portal page (not a modal) showing the tile's active variant, with the
 * floating VariantSwitcher above it when the tile has more than one.
 *
 * Rendered once from Board.tsx and driven purely by the tile-detail-store , the
 * host holds no open/close state of its own, so every entry point (tap,
 * keyboard, in-tile deep link) goes through openTileDetail. PIN-gated entries
 * (Activity) run PinGateModal before the page mounts, using the two-flag
 * pattern from SettingsButton so the gate unmounts before the page appears.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { PageHeader, Skeleton } from "@/components/ui";
import { interaction } from "../../../lib/log/interaction";
import { registerOpenModal } from "../../../lib/modal-open-store";
import { panelSession } from "../../../lib/panel-session";
import { closeTileDetail, openTileDetail, useTileDetail } from "../../../lib/tile-detail-store";
import { registryEntryForTileId } from "../../../lib/tile-registry";
import { PinGateModal } from "../../pin/PinGateModal";
import { VariantSwitcher } from "../views/VariantSwitcher";
import { getTileDetailEntry } from "./registry";
import type { TileDetailPageEntry } from "./types";

export function TileDetailHost() {
  const target = useTileDetail();
  if (!target) return null;
  const entry = getTileDetailEntry(target.tileId);
  // Actions (e.g. Frontend Logs → Settings deep link) run in the board's tap
  // handler, so they never render a page here.
  if (entry?.kind !== "page") return null;
  // Key by tileId so switching tiles fully remounts: fresh gate, fresh variant
  // selection, fresh queries.
  return <GatedTileDetail key={entry.tileId} entry={entry} initialSlug={target.variantSlug} />;
}

/**
 * Runs the PIN gate before mounting a `sensitive` page , UNLESS the panel
 * session is already unlocked. A correct PIN unlocks the whole session
 * (panel-session, decision 13: one shared Unlock), so opening a second
 * sensitive page (or the same one again) within the session skips the gate; the
 * session relocks on session end. A non-sensitive page mounts straight away.
 *
 * The gate and the page are mutually exclusive renders (no double-overlay
 * flash): while `needsGate` the gate is up and the page is not; unlocking flips
 * `useIsUnlocked`, which unmounts the gate and mounts the page in one commit.
 *
 * Exported for the host's stories, which drive it with fixture entries , the
 * real registry only carries live-wired entries.
 */
export function GatedTileDetail({
  entry,
  initialSlug,
}: {
  entry: TileDetailPageEntry;
  initialSlug: string | undefined;
}) {
  const sensitive = entry.sensitive ?? false;
  const isPrivate = registryEntryForTileId(entry.tileId)?.private ?? false;
  const unlocked = panelSession.useIsUnlocked();
  const [privateUnlocked, setPrivateUnlocked] = useState(false);
  const needsPrivateGate = isPrivate && !privateUnlocked;
  const needsSensitiveGate = sensitive && !unlocked;
  const needsGate = needsPrivateGate || needsSensitiveGate;

  return (
    <>
      {needsGate && (
        <PinGateModal
          open
          title={entry.title}
          // A cancelled gate abandons the open , back to the board.
          onClose={closeTileDetail}
          onSuccess={() => {
            if (needsPrivateGate) setPrivateUnlocked(true);
            else panelSession.unlock();
          }}
        />
      )}
      {!needsGate && <TileDetailPage entry={entry} initialSlug={initialSlug} />}
    </>
  );
}

/** The page itself: portal shell, header, variants. Mounted only while open. */
function TileDetailPage({
  entry,
  initialSlug,
}: {
  entry: TileDetailPageEntry;
  initialSlug: string | undefined;
}) {
  // Live variants , the hook runs only while the page is open (this component
  // is mounted only then), so closed tiles never run their queries.
  const { variants, loading } = entry.useVariants();
  const [slug, setSlug] = useState(initialSlug ?? entry.defaultSlug);

  // Deep links while the page is already open: the host keys by tileId, so
  // retargeting the SAME tile with a variantSlug (e.g. a TimeSuiteBanner tap
  // while another clock variant is up) re-renders without remounting , the
  // useState seed above never re-runs. Sync the requested slug from the store
  // here instead. Depending on the target OBJECT (fresh per openTileDetail
  // call), not the slug string, means a repeat request for a slug the user has
  // since switched away from still navigates.
  const target = useTileDetail();
  useEffect(() => {
    if (target?.tileId === entry.tileId && target.variantSlug !== undefined) {
      setSlug(target.variantSlug);
    }
  }, [target, entry.tileId]);

  // Freeze the board's pan for the page's lifetime and let the board's idle
  // reset dismiss it. closeTileDetail is module-stable, so unlike SettingsPage
  // no ref-routing is needed to keep this registration from churning.
  useEffect(() => registerOpenModal(() => closeTileDetail()), []);

  // Interaction log for the open/close lifecycle, mirroring SettingsPage.
  useEffect(() => {
    const target = `detail.${entry.title}`;
    interaction("modal", "open", target);
    return () => interaction("modal", "close", target);
  }, [entry.title]);

  // Escape-to-close, only while mounted (i.e. open).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeTileDetail();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const ready = !loading && variants.length > 0;
  const active = ready ? (variants.find((v) => v.slug === slug) ?? variants[0]) : null;
  // Full-bleed pages (e.g. the photo-booth camera) drop the host's PageHeader +
  // padded scroll region and render edge-to-edge, owning their own chrome.
  const fullBleed = entry.chrome === "none";

  if (fullBleed) {
    return createPortal(
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 100,
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
          color: "var(--ink)",
          fontFamily: "var(--ui)",
          overflow: "hidden",
          // Keep content clear of the notch / home indicator (see below). The
          // BOTTOM inset is deliberately absent , full-bleed pages own their
          // own bottom padding so content scrolls THROUGH the home indicator
          // instead of stopping short of a dead band.
          paddingTop: "env(safe-area-inset-top, 0px)",
          paddingLeft: "env(safe-area-inset-left, 0px)",
          paddingRight: "env(safe-area-inset-right, 0px)",
          boxSizing: "border-box",
        }}
      >
        <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
          {active?.render()}
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--ink)",
        fontFamily: "var(--ui)",
        overflow: "hidden",
        // Keep content clear of the notch / Dynamic Island. index.html sets
        // viewport-fit=cover, so without this the page draws under it. Padding
        // (not inset) so the background still fills that region.
        //
        // The BOTTOM inset is NOT reserved here. Doing so parked a fixed band
        // outside the scroll region that content could never reach , the last
        // grid row clipped against it, and the band stacked on the scroller's
        // own 24px to read as a ~1.5cm gap against 24px at the top. The inset
        // now lives in the scroll region's padding below, so content scrolls
        // through the home indicator and rests at the same 24px as the header.
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingLeft: "env(safe-area-inset-left, 0px)",
        paddingRight: "env(safe-area-inset-right, 0px)",
        boxSizing: "border-box",
      }}
    >
      <PageHeader title={entry.title} onBack={closeTileDetail} />
      {/* Full-width content region , no 720px Settings cap. Variants carry their
          own max-width (920px) until per-screen redesigns land. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "24px 24px calc(24px + env(safe-area-inset-bottom, 0px))",
        }}
      >
        {active ? (
          active.render()
        ) : (
          // Live data still loading , skeleton stack, never fabricated values.
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Skeleton w="40%" h={28} />
            <Skeleton w="100%" h={180} />
            <Skeleton w="100%" h={64} />
          </div>
        )}
      </div>
      {active && variants.length > 1 && (
        <VariantSwitcher
          variants={variants}
          activeSlug={active.slug}
          // Write the hop back to the store as well: consumers of the live
          // target (e.g. TimeSuiteBanner's open-variant suppression) must see
          // the variant the page is actually showing, not the open-time slug.
          // The sync effect above then reads the same value back , a no-op.
          onSelect={(next) => {
            setSlug(next);
            openTileDetail(entry.tileId, next);
          }}
        />
      )}
    </div>,
    document.body,
  );
}
