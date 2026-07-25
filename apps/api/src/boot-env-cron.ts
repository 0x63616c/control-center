/**
 * cron boot side-effect, mirroring `boot-env.ts` for `cron-run.ts` (the
 * `bun cron.js <name>` dispatcher every purge CronJob runs): hydrate
 * `/run/secrets/*`, derive `DATABASE_URL`, then fail-fast validate — but
 * against the "cron" runtime tier, not "api". A purge CronJob only ever mounts
 * the minimal `control-center-secrets-portal-data-purge` secret (POSTGRES_
 * PASSWORD alone, deliberately — see infra/src/secrets-map.ts), so asserting
 * the full "api" runtime's required keys (HA_TOKEN, WIFI_*, UNIFI_API_KEY,
 * HOME_LAT/LON — none of which any purge query touches) would always fail.
 * MUST be the FIRST import in `cron-run.ts`, before `cron-handlers.gen`, for
 * the same reason `boot-env.ts` must precede `server.ts`'s feature imports
 * (see its own comment; issue #27).
 */
import { initEnv } from "@www/platform/env";

initEnv("cron");
