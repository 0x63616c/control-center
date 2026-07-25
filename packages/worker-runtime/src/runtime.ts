/**
 * Worker runtime (www-7d5b.1.1). Owns scheduling and health for a set of Workers
 * so each worker only expresses its cadence + one cycle. Mirrors the
 * device-sync-service loop shape , an await-before-reschedule setTimeout per
 * worker so cycles never overlap, each run() wrapped in try/catch so one failing
 * cycle never kills its own loop or a sibling's , but generalizes it: stats are
 * accumulated per worker for failure streaks and the periodic stats snapshot.
 *
 * Shared package (www-rw07) used by the single worker app in
 * worker: the onset-or-ongoing failure logging and
 * stop() final-stats snapshot are the runtime's shape; the periodic stats
 * cadence is a fixed wall-clock interval (STATS_INTERVAL_MS).
 */
import type { Logger } from "@www/logger";
import type { Worker, WorkerRuntime, WorkerStats } from "./types";

// Mutable per-worker bookkeeping. Kept in a closure (no module-global state) so
// multiple runtimes can coexist (e.g. in tests).
interface WorkerState {
  worker: Worker;
  stats: WorkerStats;
  timer: ReturnType<typeof setTimeout> | null;
  /** When this worker last emitted a stats snapshot (epoch ms). */
  lastStatsAt: number;
}

// Interval between periodic stats snapshots. TIME-based, not every-N-runs: the
// old N=60 rule meant a 1s worker snapshotted once a minute and a 60s worker
// once an hour, so cadence tracked the worker's speed instead of the operator's
// need. Time-based makes every worker's heartbeat land at the same rate.
//
// Emitted at INFO (docs/logging.md §3: we never log below info, so that our own
// lines are readable at the prod default without unmuting third-party debug
// chatter). 5 min × ~13 workers is ~3.7k lines/day, and this is the only
// steady-state proof the loops are alive at all.
const STATS_INTERVAL_MS = 5 * 60_000;

export type WorkerRuntimeOptions = {
  /** Structured logger bound to this process root (service: "worker" | "api"). */
  logger: Logger;
};

export function createWorkerRuntime(workers: Worker[], opts: WorkerRuntimeOptions): WorkerRuntime {
  const { logger } = opts;

  const seen = new Set<string>();
  for (const w of workers) {
    if (seen.has(w.name)) throw new Error(`Duplicate worker name: ${w.name}`);
    seen.add(w.name);
  }

  // Stagger the first snapshot per worker so 13 workers don't all log in the
  // same millisecond every 5 minutes.
  const startedAt = Date.now();
  const states: WorkerState[] = workers.map((worker, index) => ({
    worker,
    timer: null,
    lastStatsAt: startedAt + index * 1_000,
    stats: {
      name: worker.name,
      lastRunAt: null,
      lastDurationMs: null,
      totalRuns: 0,
      consecutiveFailures: 0,
      lastError: null,
    },
  }));

  let running = false;

  // One cycle: run(), record stats, then reschedule , but only if still running.
  // A failure is isolated (caught, recorded) so the loop and siblings continue.
  const cycle = async (state: WorkerState): Promise<void> => {
    if (!running) return;
    const startedAt = Date.now();
    // Bind the worker name once so every log line from this cycle carries it.
    const workerLog = logger.child({ worker: state.worker.name });
    const prevConsecutiveFailures = state.stats.consecutiveFailures;
    try {
      await state.worker.run();
      state.stats.consecutiveFailures = 0;
      state.stats.lastError = null;
      // Recovery transition: log when a previously failing worker clears its streak.
      if (prevConsecutiveFailures > 0) {
        workerLog.info({ clearedStreak: prevConsecutiveFailures }, "worker recovered");
      }
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      state.stats.consecutiveFailures += 1;
      state.stats.lastError = err instanceof Error ? err.message : String(err);
      // Failure-onset transition: distinct message when a healthy worker first fails.
      if (prevConsecutiveFailures === 0) {
        workerLog.error(
          { err, consecutiveFailures: state.stats.consecutiveFailures, durationMs },
          "worker entered failing state",
        );
      } else {
        // Ongoing failure: log every cycle so the streak stays visible in prod.
        workerLog.error(
          { err, consecutiveFailures: state.stats.consecutiveFailures, durationMs },
          "worker cycle failed",
        );
      }
    } finally {
      state.stats.totalRuns += 1;
      state.stats.lastRunAt = new Date();
      state.stats.lastDurationMs = Date.now() - startedAt;
    }

    // Slow-cycle warning: this cycle took longer than its own configured interval.
    const lastDurationMs = state.stats.lastDurationMs ?? 0;
    if (lastDurationMs > state.worker.intervalMs) {
      workerLog.warn(
        {
          lastDurationMs,
          intervalMs: state.worker.intervalMs,
          ratio: Math.round((lastDurationMs / state.worker.intervalMs) * 100) / 100,
        },
        "worker cycle exceeded interval",
      );
    }

    // Periodic stats snapshot , not every cycle.
    if (Date.now() - state.lastStatsAt >= STATS_INTERVAL_MS) {
      state.lastStatsAt = Date.now();
      workerLog.info(
        {
          totalRuns: state.stats.totalRuns,
          consecutiveFailures: state.stats.consecutiveFailures,
          lastDurationMs: state.stats.lastDurationMs,
        },
        "worker stats snapshot",
      );
    }

    // Re-check after the await: stop() may have fired during the cycle, in which
    // case we must NOT schedule another tick.
    if (!running) return;
    state.timer = setTimeout(() => void cycle(state), state.worker.intervalMs);
  };

  return {
    start() {
      if (running) return;
      running = true;
      // Log each worker registration so startup is fully observable.
      for (const state of states) {
        logger.info(
          {
            worker: state.worker.name,
            intervalMs: state.worker.intervalMs,
            runOnStart: state.worker.runOnStart ?? false,
          },
          "worker registered",
        );
        if (state.worker.runOnStart) {
          void cycle(state);
        } else {
          state.timer = setTimeout(() => void cycle(state), state.worker.intervalMs);
        }
      }
    },

    stop() {
      running = false;
      // Log which workers had a pending timer so operators can see what was
      // pre-empted by the shutdown signal.
      const withTimer = states.filter((s) => s.timer !== null).map((s) => s.worker.name);
      logger.info({ timersCleared: withTimer }, "worker runtime stopped");
      for (const state of states) {
        if (state.timer !== null) {
          clearTimeout(state.timer);
          state.timer = null;
        }
      }
      // Final stats snapshot per worker at shutdown for post-mortem.
      for (const state of states) {
        logger.info(
          {
            worker: state.worker.name,
            totalRuns: state.stats.totalRuns,
            consecutiveFailures: state.stats.consecutiveFailures,
            lastDurationMs: state.stats.lastDurationMs,
            lastError: state.stats.lastError,
          },
          "worker final stats",
        );
      }
    },
  };
}
