import { defineTemporal } from "@app-kit";

/**
 * The Temporal facet (ADR-0008): the daily weather retention purge, migrated
 * from the S2 k8s CronJob seam (`weather-purge`, `bun cron.js weather-purge`).
 * Same cadence (03:00 LA, staggered off guest-wifi's 02:00), but each run is
 * now a workflow with persisted history, retry policy, and SKIP overlap
 * instead of a fire-and-forget Job pod.
 *
 * The 30-minute timeout bounds a pathological run: a normal daily purge deletes
 * one day's accumulation (~55k rows) in well under a minute; the batch caps in
 * jobs.ts (500 batches × 20k rows per table) bound the work itself, and
 * whatever a run doesn't finish is picked up next day.
 *
 * @public collected by the codegen (dynamic import in scripts/apps-gen/collect.ts,
 * an edge knip can't see) into features/_generated/schedules.gen.ts; no static import.
 */
export const temporal = defineTemporal({
  workflowTypes: ["WeatherPurgeWorkflow"],
  schedules: [
    {
      id: "purge",
      workflowType: "WeatherPurgeWorkflow",
      cron: "0 3 * * *",
      timezone: "America/Los_Angeles",
      timeout: "30 minutes",
    },
  ],
});
