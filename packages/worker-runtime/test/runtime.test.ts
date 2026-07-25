/**
 * Tests for the shared worker runtime (www-7d5b.1.1, consolidated www-rw07).
 * Union of the two former per-app suites (worker's
 * worker-runtime.test.ts + the former media-worker's runtime.test.ts):
 * await-before-reschedule scheduling (no overlap), per-cycle failure isolation (a
 * throwing worker keeps looping and never kills a sibling), the onset-or-ongoing
 * failure-logging contract, recovery/slow-cycle logging, per-worker stats, and
 * stop() (halts all loops + emits the final per-worker stats snapshot).
 *
 * Uses fake timers. Because each cycle is async, advancing timers alone is not
 * enough , we must also flush the microtask queue between the timer firing and
 * the next setTimeout being scheduled. `tick()` does both.
 */

import type { Logger } from "@www/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkerRuntime } from "../src/runtime";

// Advance fake timers by `ms` and drain any promises chained off the fired
// callbacks, so an await-before-reschedule loop reaches its next setTimeout.
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

// Minimal logger stub , records calls so tests can assert on structured log
// output without pulling in pino or a real transport. child() returns the same
// spy shape so per-cycle child loggers are observable too.
function makeLogger(): Logger {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  (log.child as ReturnType<typeof vi.fn>).mockReturnValue(log);
  return log;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduling", () => {
  it("runs runOnStart workers immediately, others after one interval", async () => {
    const eager = vi.fn().mockResolvedValue(undefined);
    const lazy = vi.fn().mockResolvedValue(undefined);
    const rt = createWorkerRuntime(
      [
        { name: "eager", intervalMs: 100, runOnStart: true, run: eager },
        { name: "lazy", intervalMs: 100, run: lazy },
      ],
      { logger: makeLogger() },
    );

    rt.start();
    await tick(0);
    expect(eager).toHaveBeenCalledTimes(1);
    expect(lazy).toHaveBeenCalledTimes(0);

    await tick(100);
    expect(eager).toHaveBeenCalledTimes(2);
    expect(lazy).toHaveBeenCalledTimes(1);

    rt.stop();
  });

  it("reschedules each cycle only after the previous one resolves (no overlap)", async () => {
    const ctl: { resolveCycle: (() => void) | null } = { resolveCycle: null };
    let concurrent = 0;
    let maxConcurrent = 0;
    const run = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          ctl.resolveCycle = () => {
            concurrent -= 1;
            resolve();
          };
        }),
    );
    const rt = createWorkerRuntime([{ name: "slow", intervalMs: 50, runOnStart: true, run }], {
      logger: makeLogger(),
    });

    rt.start();
    await tick(0);
    expect(run).toHaveBeenCalledTimes(1);

    // Even after several interval's worth of time, no second cycle starts while
    // the first is still pending , the loop awaits before scheduling.
    await tick(500);
    expect(run).toHaveBeenCalledTimes(1);

    // Resolve the in-flight cycle, let the reschedule fire.
    ctl.resolveCycle?.();
    await tick(50);
    expect(run).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(1);

    ctl.resolveCycle?.();
    rt.stop();
  });
});

describe("failure isolation", () => {
  it("a throwing worker keeps looping and does not kill a sibling", async () => {
    const boom = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom-1"))
      .mockRejectedValueOnce(new Error("boom-2"))
      .mockResolvedValue(undefined);
    const sibling = vi.fn().mockResolvedValue(undefined);
    const rt = createWorkerRuntime(
      [
        { name: "boom", intervalMs: 100, runOnStart: true, run: boom },
        { name: "sibling", intervalMs: 100, runOnStart: true, run: sibling },
      ],
      { logger: makeLogger() },
    );

    rt.start();
    await tick(0);
    expect(boom).toHaveBeenCalledTimes(1);
    expect(sibling).toHaveBeenCalledTimes(1);

    await tick(100);
    expect(boom).toHaveBeenCalledTimes(2);
    expect(sibling).toHaveBeenCalledTimes(2);

    await tick(100);
    expect(boom).toHaveBeenCalledTimes(3);
    expect(sibling).toHaveBeenCalledTimes(3);

    rt.stop();
  });
});

describe("stop", () => {
  it("halts all workers; no further cycles run", async () => {
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);
    const rt = createWorkerRuntime(
      [
        { name: "a", intervalMs: 100, runOnStart: true, run: a },
        { name: "b", intervalMs: 100, runOnStart: true, run: b },
      ],
      { logger: makeLogger() },
    );

    rt.start();
    await tick(0);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    rt.stop();
    await tick(1000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("a cycle in flight when stop() is called does not reschedule", async () => {
    const ctl: { resolveCycle: (() => void) | null } = { resolveCycle: null };
    const run = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ctl.resolveCycle = resolve;
        }),
    );
    const rt = createWorkerRuntime([{ name: "w", intervalMs: 100, runOnStart: true, run }], {
      logger: makeLogger(),
    });

    rt.start();
    await tick(0);
    expect(run).toHaveBeenCalledTimes(1);

    rt.stop();
    ctl.resolveCycle?.();
    await tick(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("throws on duplicate worker names", () => {
    expect(() =>
      createWorkerRuntime(
        [
          { name: "dup", intervalMs: 100, run: vi.fn() },
          { name: "dup", intervalMs: 100, run: vi.fn() },
        ],
        { logger: makeLogger() },
      ),
    ).toThrow(/dup/);
  });
});

describe("failure-transition logging", () => {
  it("logs 'worker entered failing state' (and binds the worker name) on the first failure", async () => {
    const log = makeLogger();
    const run = vi.fn().mockRejectedValueOnce(new Error("first-fail")).mockResolvedValue(undefined);
    const rt = createWorkerRuntime([{ name: "w", intervalMs: 100, runOnStart: true, run }], {
      logger: log,
    });

    rt.start();
    await tick(0); // first cycle , throws

    // child() is bound per cycle with the worker name.
    expect(log.child).toHaveBeenCalledWith({ worker: "w" });
    // The onset is a distinct message; a first failure is NOT logged as an
    // ongoing "worker cycle failed" (onset-or-ongoing, not both).
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ consecutiveFailures: 1 }),
      "worker entered failing state",
    );
    const firstFailMessages = (log.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(firstFailMessages).not.toContain("worker cycle failed");

    rt.stop();
  });

  it("logs 'worker cycle failed' on subsequent failures", async () => {
    const log = makeLogger();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"))
      .mockResolvedValue(undefined);
    const rt = createWorkerRuntime([{ name: "w", intervalMs: 100, runOnStart: true, run }], {
      logger: log,
    });

    rt.start();
    await tick(0); // cycle 1 , onset
    await tick(100); // cycle 2 , ongoing failure

    const messages = (log.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(messages).toContain("worker entered failing state");
    expect(messages).toContain("worker cycle failed");

    rt.stop();
  });

  it("logs 'worker recovered' with the cleared streak when a failing worker succeeds", async () => {
    const log = makeLogger();
    const run = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValue(undefined);
    const rt = createWorkerRuntime([{ name: "flaky", intervalMs: 100, runOnStart: true, run }], {
      logger: log,
    });

    rt.start();
    await tick(0); // failing cycle
    await tick(100); // recovering cycle

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ clearedStreak: 1 }),
      "worker recovered",
    );

    rt.stop();
  });
});

describe("slow-cycle warning", () => {
  it("logs 'worker cycle exceeded interval' when a cycle takes longer than intervalMs", async () => {
    const log = makeLogger();
    // Simulate a slow run by advancing the fake clock inside the mock so
    // lastDurationMs > intervalMs.
    const run = vi.fn().mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    const rt = createWorkerRuntime([{ name: "slow", intervalMs: 50, runOnStart: true, run }], {
      logger: log,
    });

    rt.start();
    await tick(0);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ lastDurationMs: expect.any(Number), intervalMs: 50 }),
      "worker cycle exceeded interval",
    );

    rt.stop();
  });
});

describe("lifecycle logging", () => {
  it("logs 'worker registered' on start()", () => {
    const log = makeLogger();
    const rt = createWorkerRuntime(
      [{ name: "my-worker", intervalMs: 500, run: vi.fn().mockResolvedValue(undefined) }],
      { logger: log },
    );

    rt.start();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ worker: "my-worker", intervalMs: 500 }),
      "worker registered",
    );

    rt.stop();
  });

  it("logs 'worker runtime stopped' and a final per-worker stats snapshot on stop()", async () => {
    const log = makeLogger();
    const rt = createWorkerRuntime(
      [{ name: "w", intervalMs: 100, runOnStart: true, run: vi.fn().mockResolvedValue(undefined) }],
      { logger: log },
    );

    rt.start();
    await tick(0);
    rt.stop();

    const infoMessages = (log.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(infoMessages).toContain("worker runtime stopped");
    expect(infoMessages).toContain("worker final stats");
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ timersCleared: expect.any(Array) }),
      "worker runtime stopped",
    );
  });
});

describe("stats snapshot cadence", () => {
  // Cadence is wall-clock (STATS_INTERVAL_MS = 5 min), not every-N-runs: a 1s
  // worker and a 60s worker must heartbeat at the same rate. Emitted at INFO
  // because we never log below info (docs/logging.md §3).
  it("emits an info stats snapshot on the wall-clock interval, not per N runs", async () => {
    const log = makeLogger();
    const run = vi.fn().mockResolvedValue(undefined);
    const rt = createWorkerRuntime([{ name: "w", intervalMs: 100, runOnStart: true, run }], {
      logger: log,
    });

    const snapshots = () =>
      (log.info as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[1])
        .filter((m) => m === "worker stats snapshot");

    rt.start();
    await tick(0); // run 1
    // 100 cycles , far past the old N=60 boundary , but only 10s of wall clock.
    for (let i = 2; i <= 100; i++) {
      await tick(100);
    }
    expect(snapshots()).toHaveLength(0);

    // Cross the 5 minute interval.
    await tick(5 * 60_000);
    expect(snapshots()).toHaveLength(1);

    rt.stop();
  });

  it("never emits below info , the runtime has no debug lines at all", async () => {
    const log = makeLogger();
    const rt = createWorkerRuntime(
      [{ name: "w", intervalMs: 100, runOnStart: true, run: vi.fn().mockResolvedValue(undefined) }],
      { logger: log },
    );

    rt.start();
    await tick(0);
    await tick(5 * 60_000);
    rt.stop();

    expect((log.debug as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
