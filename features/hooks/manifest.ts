import { defineApp } from "@app-kit";

/**
 * The hooks app (#126): a HEADLESS App — no tile, no web facet. It exists to
 * own the public GitHub webhook endpoint (`http.ts`), the `incoming_webhook`
 * table (`schema.ts`) and that table's retention purge (`jobs.ts`).
 *
 * A tileless App is legal: `scripts/apps-gen/validate.ts` requires exactly one
 * `home` tile ACROSS all apps, not one per app. A "recent deliveries" tile can
 * come later, on real data.
 */
export default defineApp({
  id: "app_hooks",
  tiles: [],
});
