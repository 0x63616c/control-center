/**
 * Cardinality guard for metric label values.
 *
 * A Prometheus label value is part of the series identity: every distinct value
 * allocates a new time series that lives for the process's lifetime and is
 * stored forever by the server. One request id, job id or user id in a label is
 * enough to turn a healthy TSDB into an OOM — this is the single most common
 * way a metrics stack takes down the thing it was meant to observe.
 *
 * Callers are still expected to pass bounded values (a route TEMPLATE, a job
 * TYPE, a cron NAME). This is the backstop for when they don't: the first
 * `limit` distinct values per key are passed through, everything after is
 * folded into `OTHER_LABEL`. A dashboard that suddenly shows a large `other`
 * bucket is a loud, cheap signal that a caller is labelling with something
 * unbounded — much better than the metrics endpoint growing without limit.
 */

/** The bucket every value beyond a key's limit collapses into. */
export const OTHER_LABEL = "other";

/**
 * Default ceiling per label key. Generous enough that no legitimate route/job/
 * cron set in this system comes close, small enough that a leak is capped.
 */
const DEFAULT_LIMIT = 200;

const seen = new Map<string, Set<string>>();

/**
 * Fold `value` into a bounded label value for `key` (`key` namespaces the
 * budget, e.g. `"http.route"`). Empty/absent values become `OTHER_LABEL` too,
 * so a metric never carries an empty-string label.
 */
export function boundedLabel(
  key: string,
  value: string | undefined,
  limit = DEFAULT_LIMIT,
): string {
  if (!value) return OTHER_LABEL;
  let values = seen.get(key);
  if (!values) {
    values = new Set<string>();
    seen.set(key, values);
  }
  if (values.has(value)) return value;
  if (values.size >= limit) return OTHER_LABEL;
  values.add(value);
  return value;
}

/** Test-only: forget every observed label value. */
export function __resetBoundedLabels(): void {
  seen.clear();
}
