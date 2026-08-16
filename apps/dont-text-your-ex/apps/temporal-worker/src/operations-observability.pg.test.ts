import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { pool as migrationPool } from "../../api/src/db/index";
import { runMigrations } from "../../api/src/db/migrate";
import { buildDatabaseUrl } from "../../api/src/env";
import { PostgresOutboxOperationalSnapshotStore } from "./operations-observability";

const databaseUrl = buildDatabaseUrl();
const HAS_DB = databaseUrl !== undefined;
const pool = new Pool({ connectionString: databaseUrl });
const ids = [`evt_${"8".repeat(32)}`, `evt_${"9".repeat(32)}`, `evt_${"a".repeat(32)}`];
let baseline = { pending: 0, oldestAgeSeconds: 0, permanentFailures: 0 };

beforeAll(async () => {
  if (!HAS_DB) return;
  await runMigrations();
  await pool.query("DELETE FROM domain_event WHERE id = ANY($1)", [ids]);
  baseline = await new PostgresOutboxOperationalSnapshotStore(pool).snapshot(11_000);
  await pool.query(
    `INSERT INTO domain_event
       (id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,
        occurred_at,state,available_at,attempt_count)
     VALUES
       ($1,'jar.created',1,'jar',$4,1,1000,'pending',1000,0),
       ($2,'jar.closed',1,'jar',$5,1,3000,'claimed',3000,1),
       ($3,'invite.issued',1,'invite',$6,1,4000,'failed',4000,10)`,
    [...ids, `jar_${"8".repeat(32)}`, `jar_${"9".repeat(32)}`, `inv_${"a".repeat(32)}`],
  );
});

afterAll(async () => {
  if (HAS_DB) await pool.query("DELETE FROM domain_event WHERE id = ANY($1)", [ids]);
  await pool.end();
  await migrationPool.end();
});

describe.skipIf(!HAS_DB)("Postgres outbox operational snapshot", () => {
  test("counts pending plus claimed work, oldest age, and quarantined events", async () => {
    const store = new PostgresOutboxOperationalSnapshotStore(pool);
    await expect(store.snapshot(11_000)).resolves.toEqual({
      pending: baseline.pending + 2,
      oldestAgeSeconds: Math.max(baseline.oldestAgeSeconds, 10),
      permanentFailures: baseline.permanentFailures + 1,
    });
  });
});
