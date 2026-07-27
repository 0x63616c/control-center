/**
 * temporal-worker boot side-effect: hydrate `/run/secrets/*` into
 * `process.env`, derive `DATABASE_URL` from the mounted POSTGRES_PASSWORD, then
 * fail-fast validate required prod env — all at module-eval.
 *
 * MUST be the FIRST import in `index.ts`, before the generated activities
 * barrel (whose feature imports construct lazy db handles from `config.X`
 * reads) — same reason as the api/worker boot-env (design spec §5.6).
 */
import { initEnv } from "@www/platform/env";

initEnv("temporal-worker");
