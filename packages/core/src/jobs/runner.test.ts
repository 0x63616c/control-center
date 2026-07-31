/**
 * Unit tests for the JobSpec → Worker bridge (relocated at S1, db-injected).
 *
 * `jobWorker` is asserted against a mocked `claimOne`: its whole job is to hand
 * its spec through to the claim, so mocking the claim is what makes that
 * delegation visible. `reapStaleJobs` owns real SQL, so it runs against the same
 * mocked-db style queue.test.ts uses , we read the emitted SQL text rather than
 * standing up a Postgres.
 *
 * Test-local `declare module "@www/core"` augmentation, same reason as
 * queue.test.ts (M1): core's own program carries no feature/apps augmentation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobQueueDb, JobSpec } from "./queue";
import { jobWorker, reapStaleJobs, staleJobReaper } from "./runner";

declare module "@www/core" {
  interface JobTypeRegistry {
    notify: { notificationId: string };
    test_job: { taskId: string };
  }
}

const noop = async () => {};

// ── mocks ────────────────────────────────────────────────────────────────────

const queueMock = vi.hoisted(() => ({
  claims: [] as Array<{ type: string; maxMs: number }>,
}));

vi.mock("./queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queue")>();
  return {
    ...actual,
    claimOne: vi.fn(async (_db: unknown, spec: JobSpec) => {
      queueMock.claims.push({ type: spec.type, maxMs: spec.maxMs });
      return true;
    }),
  };
});

const dbMock = vi.hoisted(() => ({
  /** SQL text of every execute(), in order. */
  executeLog: [] as string[],
  /**
   * RETURNING rows for the next execute() calls, shifted one per call. Each
   * row is `{ exhausted }` , whether that stranded row's attempts had already
   * reached max_attempts, mirroring the reaper's own RETURNING clause.
   */
  returningRows: [] as Array<Array<{ exhausted: boolean }>>,
}));

/** Recursively collect string content from a drizzle SQL object (see queue.test.ts). */
function sqlText(frag: unknown): string {
  if (typeof frag === "string") return frag;
  if (typeof frag === "number" || typeof frag === "boolean") return String(frag);
  if (typeof frag !== "object" || frag === null) return "";
  if ("value" in frag) {
    const v = (frag as { value: unknown }).value;
    if (Array.isArray(v)) return v.join("");
    if (typeof v === "string") return v;
  }
  if ("queryChunks" in frag && Array.isArray((frag as { queryChunks: unknown[] }).queryChunks)) {
    return (frag as { queryChunks: unknown[] }).queryChunks.map(sqlText).join("");
  }
  return "";
}

const db = {
  execute: async (frag: unknown) => {
    dbMock.executeLog.push(sqlText(frag));
    return { rows: dbMock.returningRows.shift() ?? [] };
  },
} as unknown as JobQueueDb;

beforeEach(() => {
  queueMock.claims = [];
  dbMock.executeLog = [];
  dbMock.returningRows = [];
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("jobWorker", () => {
  it("names the worker after its job type", () => {
    const w = jobWorker(db, { type: "notify", handler: noop, maxMs: 1000 });
    expect(w.name).toBe("job:notify");
  });

  it("polls every 2s and runs on start", () => {
    const w = jobWorker(db, { type: "notify", handler: noop, maxMs: 1000 });
    expect(w.intervalMs).toBe(2000);
    expect(w.runOnStart).toBe(true);
  });

  it("claims only its own type, with its own maxMs, when its cycle runs", async () => {
    const w = jobWorker(db, { type: "notify", handler: noop, maxMs: 60_000 });
    await w.run();
    expect(queueMock.claims).toEqual([{ type: "notify", maxMs: 60_000 }]);
  });

  it("gives each type an independent worker, so one cannot claim another's rows", async () => {
    const ingest = jobWorker(db, { type: "test_job", handler: noop, maxMs: 3_600_000 });
    await ingest.run();
    expect(queueMock.claims).toEqual([{ type: "test_job", maxMs: 3_600_000 }]);
  });
});

describe("reapStaleJobs", () => {
  const specs: JobSpec[] = [{ type: "test_job", handler: noop, maxMs: 60_000 }];

  it("only ever requeues rows already at status='running'", async () => {
    // Deferred jobs can sit at `queued`. A reaper that touched `queued` rows
    // would run them before their requested time.
    dbMock.returningRows = [[]];
    await reapStaleJobs(db, specs);
    const [sqlIssued] = dbMock.executeLog;
    expect(sqlIssued).toContain("status = 'running'");
    expect(sqlIssued).toContain("'queued'");
  });

  it("scopes the sweep to the spec's own type and its lease", async () => {
    dbMock.returningRows = [[]];
    await reapStaleJobs(db, specs);
    const [sqlIssued] = dbMock.executeLog;
    expect(sqlIssued).toContain("test_job");
    expect(sqlIssued).toContain("locked_at <");
    // maxMs (60s) + the 5 minute grace, in seconds. Anchored with the closing
    // paren so this can't also match 3600 or 360000.
    expect(sqlIssued).toContain("360)");
  });

  it("returns the number of rows requeued", async () => {
    dbMock.returningRows = [[{ exhausted: false }, { exhausted: false }, { exhausted: false }]];
    expect(await reapStaleJobs(db, specs)).toBe(3);
  });

  it("returns 0 when nothing is stranded", async () => {
    dbMock.returningRows = [[]];
    expect(await reapStaleJobs(db, specs)).toBe(0);
  });

  it("issues one sweep per spec and sums them", async () => {
    dbMock.returningRows = [[{ exhausted: false }], [{ exhausted: false }, { exhausted: false }]];
    const reaped = await reapStaleJobs(db, [
      { type: "notify", handler: noop, maxMs: 60_000 },
      { type: "test_job", handler: noop, maxMs: 3_600_000 },
    ]);
    expect(dbMock.executeLog).toHaveLength(2);
    expect(reaped).toBe(3);
  });

  it("sweeps nothing when given no specs", async () => {
    expect(await reapStaleJobs(db, [])).toBe(0);
    expect(dbMock.executeLog).toHaveLength(0);
  });

  it("fails a stranded row whose attempts have reached max_attempts, rather than requeueing it forever", async () => {
    // A row an OOM kill strands at `running` with attempts already at the
    // ceiling would otherwise be reclaimed and re-crash the process on every
    // cycle , this is what stops that loop. Not counted in the requeued total.
    dbMock.returningRows = [[{ exhausted: true }]];
    const reaped = await reapStaleJobs(db, specs);
    expect(reaped).toBe(0);
    const [sqlIssued] = dbMock.executeLog;
    expect(sqlIssued).toContain("'failed'");
    expect(sqlIssued).toContain("attempts >= max_attempts");
  });

  it("still requeues a stranded row below the attempts ceiling", async () => {
    dbMock.returningRows = [[{ exhausted: false }]];
    const reaped = await reapStaleJobs(db, specs);
    expect(reaped).toBe(1);
  });

  it("sums failed and requeued rows independently within one sweep", async () => {
    dbMock.returningRows = [[{ exhausted: false }, { exhausted: true }, { exhausted: false }]];
    // Only the two non-exhausted rows count as "requeued".
    expect(await reapStaleJobs(db, specs)).toBe(2);
  });
});

describe("staleJobReaper", () => {
  it("is a 5 minute worker", () => {
    const w = staleJobReaper(db, [{ type: "notify", handler: noop, maxMs: 1000 }]);
    expect(w.name).toBe("stale-job-reaper");
    expect(w.intervalMs).toBe(5 * 60_000);
  });

  it("sweeps every spec it was built from on each cycle", async () => {
    dbMock.returningRows = [[], []];
    const w = staleJobReaper(db, [
      { type: "notify", handler: noop, maxMs: 1000 },
      { type: "test_job", handler: noop, maxMs: 1000 },
    ]);
    await w.run();
    expect(dbMock.executeLog).toHaveLength(2);
  });
});
