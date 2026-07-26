/**
 * Scheduled-cycle ("cron") instrumentation (#214).
 *
 * The alerting-relevant signal for anything scheduled is NOT a rate — it is
 * "when did this last succeed", because a loop that silently stops emits
 * nothing at all and a rate-based alert on nothing is indistinguishable from a
 * healthy idle period. Hence the last-success GAUGE: an operator alerts on
 * `time() - www_cron_last_success_timestamp_seconds > <period>` and catches
 * both failure and total silence with one expression.
 *
 * Wired into @www/worker-runtime, which schedules every recurring cycle in the
 * long-lived processes (weather-ingest, the enforcers, the job pollers, the
 * stale-job reaper). Kubernetes `CronJob`s (the nightly pg dump, the retention
 * purges) are deliberately NOT covered: they are short-lived pods that exit
 * before any scrape can reach them, which needs a Pushgateway — out of scope
 * here rather than faked.
 */
import { Counter, Gauge, Histogram } from "prom-client";
import { boundedLabel } from "./bounded";
import { metricsRegistry } from "./registry";

const LABELS = ["cron"] as const;

const runs = new Counter({
  name: "www_cron_runs_total",
  help: "Scheduled cycles that ran, by cron name.",
  labelNames: LABELS,
  registers: [metricsRegistry],
});

const failures = new Counter({
  name: "www_cron_failures_total",
  help: "Scheduled cycles that threw, by cron name.",
  labelNames: LABELS,
  registers: [metricsRegistry],
});

const lastSuccess = new Gauge({
  name: "www_cron_last_success_timestamp_seconds",
  help: "Unix timestamp of the last successful run of this cron, by cron name.",
  labelNames: LABELS,
  registers: [metricsRegistry],
});

const duration = new Histogram({
  name: "www_cron_duration_seconds",
  help: "Scheduled cycle duration in seconds, by cron name.",
  labelNames: LABELS,
  // Cadences here run from a 1s enforcer tick to a 5-minute reaper sweep, and a
  // cycle that outlives its own interval is the thing worth seeing, so the
  // buckets span sub-second to minutes.
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300],
  registers: [metricsRegistry],
});

export type CronOutcome = "success" | "failure";

export type CronObservation = {
  /** The cron/cycle NAME — a fixed, code-declared identifier. */
  cron: string;
  outcome: CronOutcome;
  durationSeconds: number;
  /** Completion time in epoch MILLIseconds; defaults to now. */
  completedAtMs?: number;
};

/** Record one completed scheduled cycle. */
export function observeCronRun(o: CronObservation): void {
  const labels = { cron: boundedLabel("cron.name", o.cron) };
  runs.inc(labels);
  duration.observe(labels, o.durationSeconds);
  if (o.outcome === "failure") {
    failures.inc(labels);
    return;
  }
  lastSuccess.set(labels, (o.completedAtMs ?? Date.now()) / 1000);
}
