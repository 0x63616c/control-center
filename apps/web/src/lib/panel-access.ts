/**
 * The single client-side Panel access seam immediately before a Tile View
 * mounts. App manifests declare policy; this hook hides whether satisfaction
 * comes from the shared PIN Session or a fresh-per-opening PIN.
 *
 * ADR-0004 deliberately leaves direct API calls ungated.
 */
import { accessFor } from "@features/_generated/web.gen";
import { useState } from "react";
import { panelSession } from "./panel-session";

export function usePanelAccess(tileId: string): { canOpen: boolean; unlock: () => void } {
  const policy = accessFor(tileId);
  const sessionUnlocked = panelSession.useIsUnlocked();
  const [freshUnlocked, setFreshUnlocked] = useState(false);
  const needsFreshUnlock = policy.requiresFreshUnlock && !freshUnlocked;
  const needsSessionUnlock = policy.requiresSessionUnlock && !sessionUnlocked;

  return {
    canOpen: !needsFreshUnlock && !needsSessionUnlock,
    unlock: () => {
      if (needsFreshUnlock) setFreshUnlocked(true);
      else if (needsSessionUnlock) panelSession.unlock();
    },
  };
}
