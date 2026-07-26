/**
 * The metrics port, declared once for everything that has to agree on it: the
 * env manifest's `METRICS_PORT` default, the listener each backend starts, and
 * the `scrape.port` the infra program stamps onto every pod annotation. A
 * mismatch between any two of those is a silently-DOWN scrape target, so they
 * read the same constant instead of repeating the number.
 *
 * 9464 is the conventional Prometheus-exporter port (the OpenTelemetry
 * Prometheus exporter's default). Deliberately NOT a service's own port: the
 * api's :4201 is mapped through the Cloudflare tunnel.
 *
 * Kept in its own leaf module, importing nothing, so the env manifest can read
 * it without dragging prom-client into every consumer of `@www/platform/env`.
 */
export const DEFAULT_METRICS_PORT = 9464;

/** Path the exposition is served on. Must match the `prometheus.io/path` annotation. */
export const METRICS_PATH = "/metrics";
