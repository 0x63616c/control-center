import { runMigrations } from "./db/migrate";
import { apiPort, requireDatabaseUrl, shouldResetDatabase } from "./env";
import { resetAndSeed } from "./seed";
import { buildApp } from "./server";

// Fail fast at boot if the database is not configured (buildDatabaseUrl returns
// undefined rather than throwing so the db layer can be imported in unit tests).
requireDatabaseUrl();

await runMigrations();
// TYE_RESET=1 is only for e2e/dev reset runs. Normal local app boot must stay empty.
if (shouldResetDatabase()) {
  await resetAndSeed();
}

const app = buildApp();

const port = apiPort();

export default { port, fetch: app.fetch };
