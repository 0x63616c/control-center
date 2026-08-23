import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JarIdSchema } from "../../../../contracts";
import { pool } from "../db/index";
import { runMigrations } from "../db/migrate";
import { InviteVersionIdSchema } from "../domain-events";
import {
  AmbiguousDomainTransactionError,
  DomainTransactionRunner,
  RecordingPostCommitNudge,
} from "../domain-transaction";
import { PostgresOutbox } from "../outbox";

const HAS_DB = !!process.env.DATABASE_URL;

describe("domain transaction outcome", () => {
  it("surfaces a COMMIT response failure as ambiguous even when ROLLBACK is attempted", async () => {
    const statements: string[] = [];
    const runner = new DomainTransactionRunner({
      pool: {
        connect: async () =>
          ({
            query: async (statement: string) => {
              statements.push(statement);
              if (statement === "COMMIT") throw new Error("commit response lost");
              if (statement === "ROLLBACK") throw new Error("connection unavailable");
              return { rows: [], rowCount: 0 };
            },
            release: () => undefined,
          }) as never,
      },
    });

    await expect(runner.run(async () => "value")).rejects.toBeInstanceOf(
      AmbiguousDomainTransactionError,
    );
    expect(statements).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
  });
});

beforeAll(async () => {
  if (HAS_DB) await runMigrations();
});

beforeEach(async () => {
  if (HAS_DB) await pool.query("TRUNCATE domain_event");
});

afterAll(async () => {
  if (HAS_DB) await pool.end();
});

describe.skipIf(!HAS_DB)("domain transaction seam", () => {
  it("commits domain work and its event before nudging dispatch", async () => {
    const nudge = new RecordingPostCommitNudge();
    const runner = new DomainTransactionRunner({ pool, nudge, clock: () => 100 });
    const value = await runner.run(async ({ db, emit }) => {
      await db.query("CREATE TEMP TABLE command_result (value TEXT)");
      await db.query("INSERT INTO command_result (value) VALUES ('committed')");
      await emit({
        type: "jar.created",
        aggregateId: JarIdSchema.parse("jar_example"),
        aggregateVersion: 1,
      });
      return "ok" as const;
    });

    expect(value).toBe("ok");
    expect(nudge.calls()).toHaveLength(1);
    const claimed = await new PostgresOutbox(pool).claimPage({
      owner: "test",
      limit: 10,
      now: 100,
      leaseUntil: 200,
    });
    expect(claimed).toEqual([
      expect.objectContaining({ type: "jar.created", aggregateId: "jar_example" }),
    ]);
  });

  it("rolls back the event and never nudges when domain work fails", async () => {
    const nudge = new RecordingPostCommitNudge();
    const runner = new DomainTransactionRunner({ pool, nudge, clock: () => 100 });

    await expect(
      runner.run(async ({ emit }) => {
        await emit({
          type: "jar.created",
          aggregateId: JarIdSchema.parse("jar_rollback"),
          aggregateVersion: 1,
        });
        throw new Error("forced failure");
      }),
    ).rejects.toThrow("forced failure");
    expect(nudge.calls()).toEqual([]);
    await expect(
      new PostgresOutbox(pool).claimPage({ owner: "test", limit: 10, now: 100, leaseUntil: 200 }),
    ).resolves.toEqual([]);
  });

  it("leases each event to at most one of two concurrent Postgres dispatchers", async () => {
    const runner = new DomainTransactionRunner({ pool, clock: () => 100 });
    await runner.run(async ({ emit }) => {
      await emit({
        type: "jar.created",
        aggregateId: JarIdSchema.parse("jar_first"),
        aggregateVersion: 1,
      });
      await emit({
        type: "jar.created",
        aggregateId: JarIdSchema.parse("jar_second"),
        aggregateVersion: 1,
      });
    });
    const first = new PostgresOutbox(pool);
    const second = new PostgresOutbox(pool);

    const pages = await Promise.all([
      first.claimPage({ owner: "worker-a", limit: 2, now: 100, leaseUntil: 200 }),
      second.claimPage({ owner: "worker-b", limit: 2, now: 100, leaseUntil: 200 }),
    ]);
    const ids = pages.flat().map((event) => event.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("does not lease or increment attempts for an unsupported event type", async () => {
    const runner = new DomainTransactionRunner({ pool, clock: () => 100 });
    await runner.run(async ({ emit }) => {
      await emit({
        type: "jar.created",
        aggregateId: JarIdSchema.parse("jar_supported"),
        aggregateVersion: 1,
      });
      await emit({
        type: "invite.issued",
        aggregateId: InviteVersionIdSchema.parse("inv_0123456789abcdef0123456789abcdef"),
        aggregateVersion: 1,
      });
    });

    await expect(
      new PostgresOutbox(pool).claimPage({
        owner: "worker-a",
        limit: 10,
        now: 100,
        leaseUntil: 200,
        eventTypes: ["jar.created"],
      }),
    ).resolves.toEqual([expect.objectContaining({ type: "jar.created" })]);
    const pending = await pool.query<{ state: string; attempt_count: number }>(
      "SELECT state, attempt_count FROM domain_event WHERE event_type='invite.issued'",
    );
    expect(pending.rows).toEqual([{ state: "pending", attempt_count: 0 }]);
  });

  it("rejects arbitrary error text at the durable outbox boundary", async () => {
    const runner = new DomainTransactionRunner({ pool, clock: () => 100 });
    await runner.run(({ emit }) =>
      emit({
        type: "jar.created",
        aggregateId: JarIdSchema.parse("jar_errorcodeboundary"),
        aggregateVersion: 1,
      }),
    );

    await expect(
      pool.query("UPDATE domain_event SET last_error_code='raw provider response'"),
    ).rejects.toThrow(/check constraint/i);
  });
});
