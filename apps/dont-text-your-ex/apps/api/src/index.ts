import { pool } from "./db/index";
import { runMigrations } from "./db/migrate";
import {
  apiPort,
  moderationNarrativeKeyringSource,
  requireDatabaseUrl,
  shouldResetDatabase,
} from "./env";
import {
  createModerationNarrativeCipher,
  installModerationStore,
  PostgresModerationStore,
  parseModerationNarrativeKeyring,
} from "./moderation";
import { resetAndSeed } from "./seed";
import { buildApp } from "./server";

// Fail fast at boot if the database is not configured (buildDatabaseUrl returns
// undefined rather than throwing so the db layer can be imported in unit tests).
requireDatabaseUrl();
installModerationStore(
  new PostgresModerationStore(
    pool,
    createModerationNarrativeCipher(
      parseModerationNarrativeKeyring(moderationNarrativeKeyringSource()),
    ),
  ),
);

await runMigrations();
// TYE_RESET=1 is only for e2e/dev reset runs. Normal local app boot must stay empty.
if (shouldResetDatabase()) {
  await resetAndSeed();
}

const app = buildApp();

const port = apiPort();

// Three 2 MiB evidence images expand to just over 8 MiB as base64 JSON. Bound
// the body before Hono's JSON parser buffers it, while retaining the full
// supported three-image request.
export default { port, fetch: app.fetch, maxRequestBodySize: 9 * 1024 * 1024 };
