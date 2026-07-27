import { defineTemporal } from "@app-kit";

/**
 * The Temporal facet (ADR-0008): the daily guest-portal-data retention purge, migrated
 * from the S2 k8s CronJob seam (`guest-wifi purge cron`). Same cadence, now with
 * persisted per-run history, retry policy, and SKIP overlap instead of a
 * fire-and-forget Job pod.
 *
 * @public collected by the codegen (dynamic import in scripts/apps-gen/collect.ts,
 * an edge knip can't see) into features/_generated/schedules.gen.ts; no static import.
 */
export const temporal = defineTemporal({
  workflowTypes: ["GuestWifiPurgeWorkflow"],
  schedules: [
    {
      id: "purge",
      workflowType: "GuestWifiPurgeWorkflow",
      cron: "0 2 * * *",
      timezone: "America/Los_Angeles",
      timeout: "30 minutes",
    },
  ],
});
