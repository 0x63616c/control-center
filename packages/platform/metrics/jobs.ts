/**
 * Durable-queue job instrumentation (#214), wired into `claimOne` in
 * @www/core's job queue — the one place a job is actually claimed and run.
 *
 * Labelled by job TYPE only (`notify`, …), which is a small
 * closed set declared in code. The job ROW id is deliberately absent: it is
 * unbounded and monotonically growing, i.e. the textbook way to blow up a TSDB.
 */
import { Counter, Histogram } from "prom-client";
import { boundedLabel } from "./bounded";
import { metricsRegistry } from "./registry";

const LABELS = ["job"] as const;

const runs = new Counter({
  name: "www_job_runs_total",
  help: "Queue jobs claimed and run to completion or failure, by job type.",
  labelNames: LABELS,
  registers: [metricsRegistry],
});

const failures = new Counter({
  name: "www_job_failures_total",
  help: "Queue job runs that threw or timed out, by job type (retries count once each).",
  labelNames: LABELS,
  registers: [metricsRegistry],
});

const duration = new Histogram({
  name: "www_job_duration_seconds",
  help: "Queue job run duration in seconds, by job type.",
  labelNames: LABELS,
  // Jobs span quick notifications through longer bounded background work, so
  // these buckets remain logarithmic across that range.
  buckets: [0.05, 0.25, 1, 5, 15, 60, 300, 900, 1800, 3600],
  registers: [metricsRegistry],
});

export type JobOutcome = "success" | "failure";

export type JobObservation = {
  /** The job TYPE, never the row id. */
  job: string;
  outcome: JobOutcome;
  durationSeconds: number;
};

/**
 * Record one job RUN (one claim that reached a terminal state in this process).
 * A retry is a separate run and is counted separately — `www_job_failures_total`
 * therefore counts failed attempts, not permanently-dead jobs.
 */
export function observeJobRun(o: JobObservation): void {
  const labels = { job: boundedLabel("job.type", o.job) };
  runs.inc(labels);
  duration.observe(labels, o.durationSeconds);
  if (o.outcome === "failure") failures.inc(labels);
}
