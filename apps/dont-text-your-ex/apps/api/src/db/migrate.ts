import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@www/logger";
import { pool } from "./index";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = createLogger({ service: "tye-api" });

export async function runMigrations(): Promise<void> {
  const folder = resolve(__dirname, "migrations");
  log.info({ folder }, "migrations start");
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _tye_migrations (
        filename TEXT PRIMARY KEY,
        applied_at BIGINT NOT NULL
      )
    `);
    const { rows } = await client.query<{ filename: string }>(
      "SELECT filename FROM _tye_migrations ORDER BY filename",
    );
    const applied = new Set(rows.map((r) => r.filename));
    const files = readdirSync(folder)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(resolve(folder, file), "utf-8");
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _tye_migrations (filename, applied_at) VALUES ($1, $2)", [
        file,
        Date.now(),
      ]);
      await client.query("COMMIT");
      log.info({ file }, "migration applied");
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  log.info("migrations done");
}
