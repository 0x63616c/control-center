/**
 * Boot-time validation + the boot entry (`initEnv`). `assertEnv` is the
 * fail-fast guard (design spec §5.5): in production it crashes loudly, listing
 * every missing required key, rather than letting a feature bake a silent-wrong
 * default and 500 per request. `initEnv` is the side-effect boot sequence each
 * entrypoint imports FIRST (design spec §5.6).
 */
import { createLogger } from "@www/logger";
import { databaseUrlFromSecret, hydrateSecretFiles } from "./hydrate";
import { ENV } from "./manifest";
import { registrySpec } from "./registry";

export type BootRuntime = "api" | "worker" | "temporal-worker" | "webhook-relay";

/**
 * Fail-fast validation of required env for `runtime`. No-op unless
 * `APP_ENV === "production"` (read live — never the bundle-baked `NODE_ENV`).
 * Collects every required key (tagged to this runtime, or "all") whose hydrated
 * value is absent, empty, or malformed, then logs a structured fatal and
 * `process.exit(1)`.
 *
 * Sources its logger via `createLogger({ service: "env" })`, NOT `getLogger()`:
 * this runs from the side-effect boot import, BEFORE the entrypoint's own
 * `createLogger({ service })` call, and `getLogger()` would throw
 * "called before createLogger()" and mask the {missingKeys} diagnostic
 * (design spec §5.5).
 */
export function assertEnv(runtime: BootRuntime): void {
  if (process.env.APP_ENV !== "production") return;

  const spec = registrySpec(ENV);
  const missingKeys: string[] = [];

  for (const [key, field] of Object.entries(spec)) {
    if (!field._required) continue;
    const runtimes = field._runtimes;
    if (!(runtimes.includes("all") || runtimes.includes(runtime))) continue;

    const raw = process.env[key];
    if (raw === undefined || raw === "") {
      missingKeys.push(key);
      continue;
    }
    try {
      field.parse(raw); // a present-but-malformed required value is also fatal
    } catch {
      missingKeys.push(key);
    }
  }

  if (missingKeys.length > 0) {
    const log = createLogger({ service: "env" });
    log.fatal({ missingKeys, runtime }, "required env missing — refusing to boot");
    process.exit(1);
  }
}

/**
 * The boot sequence, invoked at module-eval from each app's `boot-env.ts`
 * (imported FIRST, before any feature import): hydrate `/run/secrets/*` into
 * `process.env`, derive `DATABASE_URL` from the mounted password, then
 * fail-fast validate. After this runs, every subsequent lazy `config.X` read —
 * including module-top pool/HA construction in the very next feature import — is
 * correct (design spec §5.6).
 */
export function initEnv(runtime: BootRuntime): void {
  hydrateSecretFiles();
  const url = databaseUrlFromSecret();
  if (url) process.env.DATABASE_URL = url;
  assertEnv(runtime);
}
