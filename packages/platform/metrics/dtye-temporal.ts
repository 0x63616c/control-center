import { Counter, Gauge, Histogram } from "prom-client";
import { boundedLabel } from "./bounded";
import { metricsRegistry } from "./registry";

const pending = new Gauge({
  name: "www_dtye_outbox_pending",
  help: "DTYE domain events waiting for dispatch, including live claims.",
  registers: [metricsRegistry],
});
const oldestAge = new Gauge({
  name: "www_dtye_outbox_oldest_age_seconds",
  help: "Age in seconds of the oldest DTYE event waiting for dispatch.",
  registers: [metricsRegistry],
});
const permanentFailures = new Gauge({
  name: "www_dtye_outbox_permanent_failures",
  help: "DTYE domain events quarantined after a permanent or exhausted failure.",
  registers: [metricsRegistry],
});
const dispatches = new Counter({
  name: "www_dtye_outbox_dispatches_total",
  help: "DTYE outbox dispatch results by bounded outcome.",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});
const dispatchLatency = new Histogram({
  name: "www_dtye_outbox_dispatch_latency_seconds",
  help: "Time from domain event occurrence until Temporal accepted its workflow operation.",
  buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 900, 3600, 21_600, 86_400],
  registers: [metricsRegistry],
});
const sessionPurgeRuns = new Counter({
  name: "www_dtye_session_purge_runs_total",
  help: "DTYE session purge page outcomes.",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});
const sessionPurgeDeleted = new Counter({
  name: "www_dtye_session_purge_deleted_total",
  help: "Expired DTYE sessions deleted by maintenance.",
  registers: [metricsRegistry],
});
const sessionPurgeDuration = new Histogram({
  name: "www_dtye_session_purge_duration_seconds",
  help: "Duration of one bounded DTYE session purge page.",
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60],
  registers: [metricsRegistry],
});
const activityLastSuccess = new Gauge({
  name: "www_dtye_temporal_activity_last_success_timestamp_seconds",
  help: "Unix timestamp of the last successful DTYE scheduled activity page.",
  labelNames: ["activity"] as const,
  registers: [metricsRegistry],
});
const accountDeletionErasureStuck = new Counter({
  name: "www_dtye_account_deletion_erasure_stuck_total",
  help: "DTYE account deletions whose local erasure had not completed after fifteen minutes.",
  registers: [metricsRegistry],
});

export type DtyeOutboxSnapshot = Readonly<{
  pending: number;
  oldestAgeSeconds: number;
  permanentFailures: number;
}>;
export type DtyeOutboxDispatchOutcome = "accepted" | "retry" | "permanent_failure";

export function observeDtyeOutboxSnapshot(snapshot: DtyeOutboxSnapshot): void {
  pending.set(snapshot.pending);
  oldestAge.set(snapshot.oldestAgeSeconds);
  permanentFailures.set(snapshot.permanentFailures);
}

export function observeDtyeOutboxDispatch(
  input: Readonly<{
    outcome: DtyeOutboxDispatchOutcome;
    latencySeconds?: number;
  }>,
): void {
  dispatches.inc({ outcome: boundedLabel("dtye.outbox.outcome", input.outcome, 3) });
  if (input.outcome === "accepted" && input.latencySeconds !== undefined) {
    dispatchLatency.observe(Math.max(0, input.latencySeconds));
  }
}

export function observeDtyeSessionPurge(
  input: Readonly<{
    outcome: "success" | "failure";
    deleted: number;
    durationSeconds: number;
    completedAtMs?: number;
  }>,
): void {
  sessionPurgeRuns.inc({ outcome: boundedLabel("dtye.session.outcome", input.outcome, 2) });
  sessionPurgeDuration.observe(Math.max(0, input.durationSeconds));
  if (input.outcome === "success") {
    sessionPurgeDeleted.inc(Math.max(0, input.deleted));
    activityLastSuccess.set(
      { activity: boundedLabel("dtye.activity", "session_maintenance", 2) },
      (input.completedAtMs ?? Date.now()) / 1000,
    );
  }
}

export function observeDtyeOutboxRecoverySuccess(completedAtMs = Date.now()): void {
  activityLastSuccess.set(
    { activity: boundedLabel("dtye.activity", "outbox_recovery", 2) },
    completedAtMs / 1000,
  );
}

export function observeDtyeAccountDeletionErasureStuck(): void {
  accountDeletionErasureStuck.inc();
}
