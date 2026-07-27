import { defineTemporal } from "@app-kit";

/**
 * The Temporal facet (ADR-0008): the daily GitHub-run retention purge,
 * migrated from the S2 k8s CronJob seam (`deploys-purge`). Same cadence
 * (05:00 LA), now with persisted per-run history, retry policy, and SKIP
 * overlap instead of a fire-and-forget Job pod.
 *
 * @public collected by the codegen (dynamic import in scripts/apps-gen/collect.ts,
 * an edge knip can't see) into features/_generated/schedules.gen.ts; no static import.
 */
export const temporal = defineTemporal({
  workflowTypes: ["DeploysPurgeWorkflow"],
  schedules: [
    {
      id: "purge",
      workflowType: "DeploysPurgeWorkflow",
      cron: "0 5 * * *",
      timezone: "America/Los_Angeles",
      timeout: "30 minutes",
    },
  ],
});
