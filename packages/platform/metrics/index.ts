/**
 * `@www/platform/metrics` — the ONE Prometheus surface for backend services.
 *
 * A runtime does exactly two things: call `initMetrics({ service })` once at
 * boot, and either serve `metricsHandler()` from a dedicated listener
 * (`startMetricsServer`) or hand it to its own server. Everything else is
 * observation helpers; no service constructs a Counter/Gauge/Histogram or its
 * own Registry, for the same reason no component constructs an AudioContext.
 *
 * Every metric name is `www_`-prefixed, and every label value passes through
 * `boundedLabel` — see `bounded.ts` for why an unbounded label is the fastest
 * way to break a metrics stack.
 */
export { __resetBoundedLabels, boundedLabel, OTHER_LABEL } from "./bounded";
export { type CronObservation, type CronOutcome, observeCronRun } from "./cron";
export {
  type DtyeOutboxDispatchOutcome,
  type DtyeOutboxSnapshot,
  observeDtyeAccountDeletionErasureStuck,
  observeDtyeOutboxDispatch,
  observeDtyeOutboxRecoverySuccess,
  observeDtyeOutboxSnapshot,
  observeDtyeSessionPurge,
} from "./dtye-temporal";
export { type HttpObservation, observeHttpRequest, statusClass } from "./http";
export { type JobObservation, type JobOutcome, observeJobRun } from "./jobs";
export { DEFAULT_METRICS_PORT, METRICS_PATH } from "./port";
export {
  __resetMetrics,
  initMetrics,
  type MetricsInit,
  metricsHandler,
  metricsRegistry,
} from "./registry";
export { type MetricsServer, type MetricsServerOptions, startMetricsServer } from "./server";
