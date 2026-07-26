import type { IntegrationSyncStore } from "./store";

/**
 * Per-integration liveness + failure-streak recorder (www-355t.9), backed by an
 * `IntegrationSyncStore`. `consecutiveFailures` is a real streak: reset to 0 on
 * success, prior value + 1 on error.
 *
 * NOTE: github-actions keeps its own poller status in `github_poll_status` (a
 * different table with extra fields), so it does not use this helper.
 */
export interface IntegrationHeartbeat {
  /** Record a successful cycle: fresh poll time, no error, streak reset to 0. */
  ok(): Promise<void>;
  /** Record a failed cycle; returns the new consecutive-failure streak. */
  fail(error: string): Promise<number>;
}

export function heartbeat(
  store: IntegrationSyncStore,
  integrationId: string,
): IntegrationHeartbeat {
  return {
    async ok() {
      await store.recordOk(integrationId);
    },
    async fail(error: string) {
      return store.recordFail(integrationId, error);
    },
  };
}

/**
 * Run one reconcile cycle and record the heartbeat: on success mark ok, on
 * failure record the new failure streak, THEN RETHROW the original error (www-
 * bd0c). This module used to swallow the error here and log it directly, but
 * that hid every failing cycle from the worker runtime
 * (packages/worker-runtime/src/runtime.ts), which owns the onset/ongoing/
 * recovery transition logging ("worker entered failing state" / "worker cycle
 * failed" / "worker recovered") and the consecutiveFailures/lastError/
 * durationMs fields in "worker final stats" (docs/logging.md §6). The runtime
 * already isolates a throwing cycle from its siblings (try/catch per worker in
 * its scheduling loop), so rethrowing here is safe , it does not crash the
 * process or starve other workers. Callers that invoke a cycle function
 * directly outside the runtime (e.g. tests, admin "run now" routes) will now
 * see the rejection instead of a silent resolve; that is the point; see
 * heartbeat.test.ts.
 *
 * `label` is kept for call-site readability but is no longer used to log here
 * , the runtime's per-worker logger already carries the worker name.
 */
export async function runCycle(
  hb: IntegrationHeartbeat,
  _label: string,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
    await hb.ok();
  } catch (err) {
    // Record the failure streak BEFORE propagating , the heartbeat write must
    // land even though the caller is about to see a rejection.
    await hb.fail(err instanceof Error ? err.message : String(err));
    throw err;
  }
}
