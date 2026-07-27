/**
 * Every knob this runtime reads, projected from the ONE env manifest
 * (`@www/platform/env`). Nothing here touches `process.env` directly — that is
 * the rule the whole repo enforces, after an import-order bug froze feature
 * config at pre-hydration defaults in prod.
 */
import { ENV } from "@www/platform/env";

export interface TemporalWorkerConfig {
  readonly address: string;
  readonly namespace: string;
  readonly taskQueue: string;
  /** Port the Prometheus exposition listener binds (#214). */
  readonly metricsPort: number;
  /**
   * OTel collector the SDK's own Runtime.install({ telemetryOptions }) sends
   * worker-internal metrics to (#233) — separate from metricsPort above, which
   * is this worker's own app-level @www/platform/metrics listener.
   */
  readonly otelCollectorUrl: string;
}

/** @public - read once at boot in index.ts. */
export function temporalWorkerConfig(): TemporalWorkerConfig {
  const env = ENV.pick(
    "TEMPORAL_ADDRESS",
    "TEMPORAL_NAMESPACE",
    "TEMPORAL_TASK_QUEUE",
    "METRICS_PORT",
    "TEMPORAL_OTEL_COLLECTOR_URL",
  );
  return {
    address: env.TEMPORAL_ADDRESS,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue: env.TEMPORAL_TASK_QUEUE,
    metricsPort: env.METRICS_PORT,
    otelCollectorUrl: env.TEMPORAL_OTEL_COLLECTOR_URL,
  };
}
