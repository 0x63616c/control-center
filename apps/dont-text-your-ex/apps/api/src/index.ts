import { runMigrations } from "./db/migrate";
import { requireDatabaseUrl } from "./env";
import { resetAndSeed } from "./seed";
import { buildApp } from "./server";

// Fail fast at boot if the database is not configured (buildDatabaseUrl returns
// undefined rather than throwing so the db layer can be imported in unit tests).
requireDatabaseUrl();

await runMigrations();
// TYE_RESET=1 is only for e2e/dev reset runs. Normal local app boot must stay empty.
if (process.env.TYE_RESET === "1" && process.env.APP_ENV !== "production") {
  await resetAndSeed();
}

const app = buildApp();

const port = Number(process.env.PORT ?? 8787);

export default { port, fetch: app.fetch };
