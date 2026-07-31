/**
 * Unit tests for the generic job queue (www-kp4k.12; relocated at S1).
 * Tests: single-flight claim (SKIP LOCKED semantics mocked), single-type claim,
 * the run_after gate, retry+backoff, max_attempts→failed, and the per-job
 * timeout (both the AbortSignal and the promise race that backs it).
 *
 * core has no module-singleton db (queue.ts is db-injected), so this test
 * builds its own mock `JobQueueDb` and passes it explicitly to every call ,
 * no module mock needed. A test-local `declare module "@www/core"`
 * augmentation registers the literal job types this file exercises: core's own
 * program carries no feature/apps augmentation, so `"notify"` / "my_job" would
 * otherwise collapse to `never` (see docs/superpowers/plans/units/
 * 2026-07-23-S1-worker-job-seam.review.md, finding M1).
 *
 * Design note: drizzle sql`` objects have a `queryChunks` array containing
 * `SQLRaw` (strings) and `Param` (values). Status literals like 'done' live
 * in the SQLRaw chunks. We walk them to find the terminal status branch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimOne, enqueueJob, type JobQueueDb, type JobSpec, releaseInFlightJobs } from "./queue";

declare module "@www/core" {
  interface JobTypeRegistry {
    notify: { notificationId: string };
    test_job: { taskId: string };
    my_job: { foo?: string };
  }
}

// ── DB mock ───────────────────────────────────────────────────────────────────

const mockState = vi.hoisted(() => ({
  claimedRow: null as {
    id: number;
    type: string;
    payload: unknown;
    attempts: number;
    max_attempts: number;
  } | null,
  // Flat log of UPDATE sql frag objects (after the claim SELECT).
  executeLog: [] as unknown[],
  inserts: [] as Array<Record<string, unknown>>,
}));

/**
 * Recursively collect all string content from a drizzle SQL object.
 * Structure (from drizzle-orm source):
 *   SQL object: { queryChunks: Array<SQLRaw | Param | SQL | number | ...> }
 *   SQLRaw:     { value: string[] }   ← array of string literals
 *   Param:      bare primitive (number, string, Date, ...)
 */
function sqlText(frag: unknown): string {
  if (typeof frag === "string") return frag;
  if (typeof frag === "number" || typeof frag === "boolean") return String(frag);
  if (frag instanceof Date) return frag.toISOString();
  if (typeof frag !== "object" || frag === null) return "";

  // SQLRaw: { value: string[] }
  if ("value" in frag) {
    const v = (frag as { value: unknown }).value;
    if (Array.isArray(v)) return v.join("");
    if (typeof v === "string") return v;
  }

  // SQL composite: { queryChunks: [...] }
  if ("queryChunks" in frag && Array.isArray((frag as { queryChunks: unknown[] }).queryChunks)) {
    return (frag as { queryChunks: unknown[] }).queryChunks.map(sqlText).join("");
  }
  return "";
}

function makeDb(): JobQueueDb {
  const db: JobQueueDb = {
    transaction: (async (fn: (tx: JobQueueDb) => Promise<unknown>) =>
      fn(db)) as JobQueueDb["transaction"],

    execute: (async (sqlFrag: unknown) => {
      const text = sqlText(sqlFrag);
      mockState.executeLog.push(text);

      // The claim SELECT returns the queued row.
      if (text.includes("SKIP LOCKED")) {
        return { rows: mockState.claimedRow ? [mockState.claimedRow] : [] };
      }
      return { rows: [] };
    }) as JobQueueDb["execute"],

    insert: ((_table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        mockState.inserts.push(row);
        return {
          returning: (_fields: unknown) => Promise.resolve([{ id: mockState.inserts.length }]),
          onConflictDoNothing: () => ({
            returning: (_fields: unknown) => Promise.resolve([{ id: 1 }]),
          }),
        };
      },
    })) as unknown as JobQueueDb["insert"],
  };
  return db;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRow(
  overrides: Partial<{
    id: number;
    type: string;
    payload: unknown;
    attempts: number;
    max_attempts: number;
  }> = {},
) {
  return {
    id: 1,
    type: "test_job",
    payload: { x: 1 },
    attempts: 0,
    max_attempts: 5,
    ...overrides,
  };
}

function spec(type: JobSpec["type"], handler: JobSpec["handler"], maxMs: number): JobSpec {
  return { type, handler, maxMs };
}

/** True if any logged SQL text contains the given keyword. */
function logContains(keyword: string): boolean {
  return (mockState.executeLog as string[]).some(
    (s) => typeof s === "string" && s.includes(keyword),
  );
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

let db: JobQueueDb;

beforeEach(() => {
  mockState.claimedRow = null;
  mockState.executeLog = [];
  mockState.inserts = [];
  db = makeDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("enqueueJob", () => {
  it("inserts a job row and returns its id", async () => {
    const id = await enqueueJob(db, "my_job", { foo: "bar" });
    expect(id).toBeGreaterThan(0);
    expect(mockState.inserts).toHaveLength(1);
    expect(mockState.inserts[0]).toMatchObject({ type: "my_job" });
  });

  it("accepts priority and runAfter options", async () => {
    const future = new Date(Date.now() + 60_000);
    await enqueueJob(db, "my_job", {}, { priority: 5, runAfter: future, maxAttempts: 3 });
    expect(mockState.inserts[0]).toMatchObject({
      priority: 5,
      runAfter: future,
      maxAttempts: 3,
    });
  });
});

describe("claimOne , empty queue", () => {
  it("returns false when no job of that type is queued", async () => {
    const result = await claimOne(
      db,
      spec("notify", async () => {}, 1000),
    );
    expect(result).toBe(false);
  });

  it("issues the FOR UPDATE SKIP LOCKED claim query", async () => {
    await claimOne(
      db,
      spec("notify", async () => {}, 1000),
    );
    expect(logContains("SKIP LOCKED")).toBe(true);
  });
});

describe("claimOne , single-type claim", () => {
  it("restricts the claim to the requested type", async () => {
    await claimOne(
      db,
      spec("notify", async () => {}, 1000),
    );
    expect(logContains("type =")).toBe(true);
    expect(logContains("notify")).toBe(true);
  });

  it("never claims a job whose run_after is in the future", async () => {
    // Jobs can be deliberately deferred. Dropping this predicate would claim
    // them before their requested run time.
    await claimOne(
      db,
      spec("test_job", async () => {}, 1000),
    );
    expect(logContains("run_after <= now()")).toBe(true);
  });
});

describe("claimOne , dispatch", () => {
  it("calls the handler with the payload and an AbortSignal", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    mockState.claimedRow = makeRow({ type: "notify", payload: { hello: "world" } });

    const result = await claimOne(db, spec("notify", handler, 1000));

    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toEqual({ hello: "world" });
    expect(handler.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it("marks the job done on handler success", async () => {
    mockState.claimedRow = makeRow({ type: "notify" });
    await claimOne(
      db,
      spec("notify", async () => {}, 1000),
    );

    expect(logContains("done")).toBe(true);
    expect(logContains("failed")).toBe(false);
  });
});

describe("claimOne , retry + backoff", () => {
  it("requeues with backoff when the handler throws and retries remain", async () => {
    mockState.claimedRow = makeRow({ type: "notify", attempts: 0, max_attempts: 5 });
    await claimOne(
      db,
      spec(
        "notify",
        async () => {
          throw new Error("transient");
        },
        1000,
      ),
    );

    expect(logContains("run_after")).toBe(true);
    expect(logContains("transient")).toBe(true);
    expect(logContains("failed")).toBe(false);
    expect(logContains("done")).toBe(false);
  });

  it("permanently fails once attempts reach max_attempts", async () => {
    mockState.claimedRow = makeRow({ type: "notify", attempts: 0, max_attempts: 1 });
    await claimOne(
      db,
      spec(
        "notify",
        async () => {
          throw new Error("permanent");
        },
        1000,
      ),
    );

    expect(logContains("failed")).toBe(true);
    expect(logContains("done")).toBe(false);
  });

  it("permanently fails on the last retry (attempts 4 of max_attempts 5)", async () => {
    // Exercises the actual boundary arithmetic , attempts is pre-increment
    // (claimOne adds one more below), so 4/5 is the final allowed retry.
    mockState.claimedRow = makeRow({ type: "notify", attempts: 4, max_attempts: 5 });
    await claimOne(
      db,
      spec(
        "notify",
        async () => {
          throw new Error("permanent");
        },
        1000,
      ),
    );

    expect(logContains("failed")).toBe(true);
    expect(logContains("done")).toBe(false);
  });
});

describe("claimOne , timeout", () => {
  it("fails the job when the handler exceeds maxMs", async () => {
    mockState.claimedRow = makeRow({ type: "notify", attempts: 0, max_attempts: 1 });
    await claimOne(
      db,
      spec("notify", () => new Promise((resolve) => setTimeout(resolve, 5_000)), 50),
    );

    expect(logContains("failed")).toBe(true);
    expect(logContains("timed out")).toBe(true);
    expect(logContains("done")).toBe(false);
  });

  it("aborts the signal it passes to the handler on timeout", async () => {
    mockState.claimedRow = makeRow({ type: "notify", attempts: 0, max_attempts: 1 });
    let aborted = false;
    await claimOne(
      db,
      spec(
        "notify",
        (_payload, signal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            });
            setTimeout(resolve, 5_000);
          }),
        50,
      ),
    );

    expect(aborted).toBe(true);
  });

  it("does not leave a timer running after a fast handler", async () => {
    mockState.claimedRow = makeRow({ type: "notify" });
    const signals: AbortSignal[] = [];
    await claimOne(
      db,
      spec(
        "notify",
        async (_payload, signal) => {
          signals.push(signal);
        },
        50,
      ),
    );
    // The race timer is cleared in `finally`; the signal stays unaborted.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(signals[0]?.aborted).toBe(false);
  });
});

describe("releaseInFlightJobs", () => {
  it("returns 0 and issues no UPDATE when nothing is in flight", async () => {
    expect(await releaseInFlightJobs(db)).toBe(0);
    expect(mockState.executeLog).toHaveLength(0);
  });

  it("aborts the in-flight handler and requeues the row for immediate reclaim", async () => {
    // The deploy case: SIGTERM lands mid-job. Without this the row remains
    // `running` until its reaper lease expires.
    mockState.claimedRow = makeRow({ id: 42, type: "test_job" });
    let aborted = false;

    const claim = claimOne(
      db,
      spec(
        "test_job",
        (_payload, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
        60_000,
      ),
    );

    // Let claimOne register the in-flight entry and enter the handler.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await releaseInFlightJobs(db)).toBe(1);
    await claim;

    expect(aborted).toBe(true);
    expect(logContains("run_after = now()")).toBe(true);
    expect(logContains("GREATEST(attempts - 1, 0)")).toBe(true);
    expect(logContains("'queued'")).toBe(true);
  });

  it("does not let the aborted handler burn a retry or fail the job", async () => {
    // claimOne's catch would otherwise requeue with backoff (delaying reclaim)
    // or, at max_attempts, permanently fail a job that never actually failed.
    mockState.claimedRow = makeRow({ id: 43, type: "notify", attempts: 0, max_attempts: 1 });

    const claim = claimOne(
      db,
      spec(
        "notify",
        (_payload, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
        60_000,
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    await releaseInFlightJobs(db);
    await claim;

    expect(logContains("'failed'")).toBe(false);
    expect(logContains("make_interval")).toBe(false);
    expect(logContains("'done'")).toBe(false);
  });

  it("forgets the job once claimOne returns, so a later release is a no-op", async () => {
    mockState.claimedRow = makeRow({ id: 44, type: "notify" });
    await claimOne(
      db,
      spec("notify", async () => {}, 1_000),
    );
    mockState.executeLog = [];

    expect(await releaseInFlightJobs(db)).toBe(0);
    expect(mockState.executeLog).toHaveLength(0);
  });
});
