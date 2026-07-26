/**
 * HTTP / tRPC request instrumentation (#214).
 *
 * Three series, all label-bounded: `route` is a TEMPLATE the caller resolves
 * (the matched route-table path, the tRPC procedure name, or `other`) and never
 * a raw pathname, and status collapses to a class rather than a code — a
 * per-code label buys nothing a class doesn't and multiplies the series count.
 * Request ids, device ids and query strings must never reach this function;
 * `boundedLabel` is the backstop if one does.
 */
import { Counter, Histogram } from "prom-client";
import { boundedLabel, OTHER_LABEL } from "./bounded";
import { metricsRegistry } from "./registry";

/** Methods that get their own label value; anything else folds into `other`. */
const KNOWN_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

const LABELS = ["method", "route", "status_class"] as const;

const requests = new Counter({
  name: "www_http_requests_total",
  help: "HTTP/tRPC requests served, by route template and status class.",
  labelNames: LABELS,
  registers: [metricsRegistry],
});

const errors = new Counter({
  name: "www_http_request_errors_total",
  help: "HTTP/tRPC requests that failed (5xx, or a handler that threw).",
  labelNames: LABELS,
  registers: [metricsRegistry],
});

const duration = new Histogram({
  name: "www_http_request_duration_seconds",
  help: "HTTP/tRPC request latency in seconds, by route template and status class.",
  labelNames: LABELS,
  // Panel-facing API: sub-100ms is the interesting region, and 10s is already a
  // hard failure, so the buckets crowd the fast end rather than spanning orders
  // of magnitude uniformly.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/** `2xx` / `3xx` / `4xx` / `5xx`; anything nonsensical folds into `other`. */
export function statusClass(status: number): string {
  if (!Number.isFinite(status) || status < 100 || status > 599) return OTHER_LABEL;
  return `${Math.floor(status / 100)}xx`;
}

export type HttpObservation = {
  /**
   * A bounded route TEMPLATE — the matched route-table path, a tRPC procedure
   * name, or `"other"`. Never a raw pathname containing an id.
   */
  route: string;
  method: string;
  status: number;
  durationSeconds: number;
  /**
   * Force the error counter even on a non-5xx status — for a handler that threw
   * before a status was ever chosen.
   */
  failed?: boolean;
};

/** Record one served request against all three HTTP series. */
export function observeHttpRequest(o: HttpObservation): void {
  const method = KNOWN_METHODS.has(o.method) ? o.method : OTHER_LABEL;
  const labels = {
    method,
    route: boundedLabel("http.route", o.route),
    status_class: statusClass(o.status),
  };
  requests.inc(labels);
  duration.observe(labels, o.durationSeconds);
  if (o.failed || o.status >= 500) errors.inc(labels);
}
