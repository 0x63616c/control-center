import { defineTemporal } from "@app-kit";

/**
 * The Temporal facet (ADR-0008): the `health-check` liveness Schedule, formerly
 * hardcoded in apps/temporal-worker/src/schedule.ts. A green run of
 * HealthCheckWorkflow is the end-to-end liveness proof for the whole stack —
 * server, Postgres, task queue, and worker.
 *
 * `iterations` was previously the TEMPORAL_HEALTH_CHECK_ITERATIONS env knob; it
 * was never overridden in prod, so it is now plain facet data (5 activities
 * paced across the minute = one 12s slot each).
 *
 * The 2-minute timeout: the run spends the whole minute pacing its checks, so a
 * run still going when the next is due means something is genuinely wedged.
 * Overlap policy is SKIP (reconciler default): a backlog of health checks tells
 * you nothing the missed-run gap in history doesn't already.
 *
 * @public collected by the codegen (dynamic import in scripts/apps-gen/collect.ts,
 * an edge knip can't see) into features/_generated/schedules.gen.ts; no static import.
 */
export const temporal = defineTemporal({
  workflowTypes: ["HealthCheckWorkflow"],
  schedules: [
    {
      id: "health-check",
      workflowType: "HealthCheckWorkflow",
      cron: "* * * * *",
      args: { iterations: 5 },
      timeout: "2 minutes",
      catchupWindow: "1 minute",
    },
  ],
});
