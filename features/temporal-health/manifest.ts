import { defineApp } from "@app-kit";

/**
 * The temporal-health app manifest (ADR-0008). This App owns the Temporal
 * liveness canary — HealthCheckWorkflow and its once-a-minute Schedule — folded
 * out of apps/temporal-worker's hardcoded schedule.ts so that ZERO schedules
 * live outside the declarative facet system. It renders nothing: `tiles` is
 * empty, and the folder exists purely to carry the temporal facet.
 */
export default defineApp({
  id: "app_temporal_health",
  tiles: [],
});
