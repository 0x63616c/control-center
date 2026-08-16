import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool as migrationPool } from "../../api/src/db/index";
import { runMigrations } from "../../api/src/db/migrate";
import { buildDatabaseUrl } from "../../api/src/env";
import { PostgresSessionMaintenanceStore } from "./session-maintenance";

const databaseUrl = buildDatabaseUrl();
const HAS_DB = databaseUrl !== undefined;
const pool = new Pool({ connectionString: databaseUrl });
const userId = "usr_sessionmaintenance";

beforeAll(async () => {
  if (!HAS_DB) return;
  await runMigrations();
  await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  await pool.query("INSERT INTO users (id, name, created_at) VALUES ($1, $2, $3)", [
    userId,
    "Session maintenance test",
    1,
  ]);
});

afterAll(async () => {
  if (HAS_DB) await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  await pool.end();
  await migrationPool.end();
});

describe.skipIf(!HAS_DB)("Postgres session maintenance", () => {
  it("purges bounded expired pages while preserving active sessions", async () => {
    const values: unknown[] = [];
    const rows = Array.from({ length: 502 }, (_, index) => {
      const offset = values.length;
      values.push(`sess_maintenance${index}`, userId, 1, index === 501 ? 101 : 99, 1);
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5})`;
    });
    await pool.query(
      `INSERT INTO sessions (token,user_id,created_at,expires_at,last_used_at) VALUES ${rows.join(",")}`,
      values,
    );

    const store = new PostgresSessionMaintenanceStore(pool);
    await expect(store.purgeExpired({ now: 100, limit: 500 })).resolves.toEqual({ deleted: 500 });
    await expect(store.purgeExpired({ now: 100, limit: 500 })).resolves.toEqual({ deleted: 1 });
    await expect(store.purgeExpired({ now: 100, limit: 500 })).resolves.toEqual({ deleted: 0 });
    const active = await pool.query<{ token: string }>(
      "SELECT token FROM sessions WHERE user_id=$1 ORDER BY token",
      [userId],
    );
    expect(active.rows).toEqual([{ token: "sess_maintenance501" }]);
  });
});
