/**
 * Generic cron dispatch entrypoint (S2). The api image bundles this to
 * cron.js; a k8s CronJob runs `bun cron.js <name>` per entry emitted by
 * infra/src/crons.ts from features/_generated/crons.gen.ts. This file looks
 * the name up in the generated handler barrel (cron-handlers.gen.ts) and
 * invokes its run(), then exits — a one-shot job (PRD Backend rule 7), NOT a
 * worker loop, mirroring purge.ts's shape.
 */
// Must run before CRON_HANDLERS is imported: that import eagerly constructs
// each feature's Pool/drizzle from DATABASE_URL, which boot-env-cron derives
// from the mounted POSTGRES_PASSWORD secret + POSTGRES_HOST. Skipping this (as
// this entrypoint used to) leaves DATABASE_URL unset, NODE_ENV/APP_ENV
// non-"production", so the registry's devDefault silently points every purge
// cron at localhost:5432 instead of the real cluster DB. The "cron" runtime
// (not "api") matters too: a purge CronJob only mounts the minimal
// portal-data-purge secret, so asserting api's full required-key set (HA/
// WIFI/UniFi, none of which a purge query touches) would always fail — see
// issue #27.
import "./boot-env-cron";
import { CRON_HANDLERS } from "@features/_generated/cron-handlers.gen";
import { createLogger } from "@www/logger";

const log = createLogger({ service: "cron" });

/** @public — invoked by the top-level guard AND the seam test. */
export async function runCron(name: string | undefined): Promise<void> {
  if (!name) throw new Error("cron-run: no cron name given (usage: bun cron.js <name>)");
  const handler = CRON_HANDLERS[name];
  if (!handler) {
    throw new Error(
      `cron-run: unknown cron '${name}' (known: ${Object.keys(CRON_HANDLERS).join(", ")})`,
    );
  }
  await handler();
  log.info({ cron: name }, "cron complete");
}

// import.meta.main guards the dispatch so importing this file in a test (node,
// where import.meta.main is undefined) is inert; bun sets it true only for the
// entry module, so `bun cron.js <name>` dispatches for real.
if (import.meta.main) {
  try {
    await runCron(process.argv[2]);
    process.exit(0);
  } catch (err) {
    log.error({ err, cron: process.argv[2] }, "cron failed");
    process.exit(1);
  }
}
