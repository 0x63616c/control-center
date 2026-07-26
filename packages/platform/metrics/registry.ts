/**
 * The ONE Prometheus registry for every backend runtime in this system (#214).
 *
 * Shared substrate on purpose (same rule as the sound bus and the env registry):
 * a service that builds its own `new Registry()` gets its own exposition text,
 * its own default-label set and its own naming conventions, and the union of
 * those is not a queryable metrics estate. Services declare observations
 * through the typed helpers in `http.ts` / `jobs.ts` / `cron.ts`; nothing
 * outside this folder constructs a Counter/Gauge/Histogram.
 *
 * Every metric this repo owns is prefixed `www_`, so `www_*` is exactly "our
 * instrumentation" and everything else in the endpoint is prom-client's own
 * process/runtime collection.
 */
import { collectDefaultMetrics, Registry } from "prom-client";

/** The registry every `www_*` metric registers into. */
export const metricsRegistry = new Registry();

export type MetricsInit = {
  /**
   * Stamped on EVERY series as the `service` label (api, worker,
   * temporal-worker). A default label rather than a per-metric one so no helper
   * has to thread it and no caller can forget it.
   */
  service: string;
  /**
   * prom-client's process/runtime collection (`process_cpu_seconds_total`,
   * `nodejs_heap_size_bytes`, event-loop lag, …). On by default; the only
   * reason to turn it off is a test that wants a deterministic exposition.
   */
  collectDefaults?: boolean;
};

let initialised = false;

/**
 * Bind this process's identity to the registry and start default collection.
 * Idempotent — calling twice is a no-op rather than a double-registration
 * throw, so a second entrypoint in the same process (api's guest listener) is
 * safe.
 */
export function initMetrics(init: MetricsInit): void {
  if (initialised) return;
  initialised = true;
  metricsRegistry.setDefaultLabels({ service: init.service });
  if (init.collectDefaults ?? true) {
    collectDefaultMetrics({ register: metricsRegistry });
  }
}

/**
 * The exposition response: the full registry rendered in Prometheus text
 * format, with the content-type prom-client's own format negotiation picked.
 * Returns a web-standard `Response` so the same function serves both a
 * `Bun.serve` route (api) and the `node:http` listener in `server.ts`.
 */
export async function metricsHandler(): Promise<Response> {
  const body = await metricsRegistry.metrics();
  return new Response(body, {
    status: 200,
    headers: { "content-type": metricsRegistry.contentType },
  });
}

/**
 * Test-only: zero every series and re-arm `initMetrics`. Deliberately
 * `resetMetrics()` and not `clear()` — the metric objects are module-level
 * singletons created at import, so clearing the registry would unregister them
 * permanently and every later observation would vanish.
 */
export function __resetMetrics(): void {
  metricsRegistry.resetMetrics();
  metricsRegistry.setDefaultLabels({});
  initialised = false;
}
