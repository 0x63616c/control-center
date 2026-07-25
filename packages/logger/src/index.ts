// All process.env reads for the logger (LOG_LEVEL, LOG_PRETTY, APP_ENV) live
// HERE and nowhere else, call sites never read env directly. See docs/logging.md §3.
//
// NOTE: we deliberately do NOT key behavior on process.env.NODE_ENV. The api,
// the worker ships as a bun single-file bundle, and bun INLINES
// process.env.NODE_ENV to a build-time literal, so a NODE_ENV check is frozen
// at build and ignores the container's runtime env (it crash-looped prod once,
// www-rw07). LOG_PRETTY / APP_ENV / LOG_LEVEL are read live at runtime instead.
import pino, { type Logger as PinoLogger } from "pino";
// pino-pretty imported as a SYNCHRONOUS stream factory (not a pino.transport
// target): transports spawn a thread-stream worker that re-resolves "pino-pretty"
// from a file path which does not exist inside a single-file bundle. A sync
// stream is bundled inline and works everywhere.
import prettyStream from "pino-pretty";

/**
 * The logger our own code is allowed to use. Deliberately has NO `debug`
 * method: every line WE write is `info` or above, so it is visible at the prod
 * default level and we never have to raise `LOG_LEVEL` to read our own
 * diagnostics. Raising it to `debug` would also unmute every third-party
 * library that logs through pino (drizzle, node internals, HTTP clients),
 * which is noise we did not ask for and cannot tune per-source.
 *
 * The corollary: a line that isn't worth `info` in steady state does not get
 * demoted to `debug`, it gets made to fire LESS (on transition/change, not per
 * tick). See `logChange` below and docs/logging.md §3.
 *
 * `debug`/`trace` are omitted at the TYPE level rather than banned by a lint
 * rule so a `.debug(...)` call is a compile error at every call site. Code we
 * don't own still logs at debug through its own pino instance, unaffected.
 *
 * @public, Logger type used at every service call site.
 */
export type Logger = Omit<PinoLogger, "debug" | "trace" | "child"> & {
  child(bindings: pino.Bindings, options?: pino.ChildLoggerOptions): Logger;
};

export type CreateLoggerOptions = {
  /** Service name bound on every line, e.g. "api" | "worker". */
  service: string;
  /** Environment string, bound on every line. Defaults to APP_ENV ?? "development". */
  env?: string;
  /** Explicit level override. Defaults to LOG_LEVEL env, else "debug" (pretty) / "info" (JSON). */
  level?: string;
  /**
   * Force pretty (true) or JSON (false) output. When omitted, defaults to JSON
   * and opts into pretty only when LOG_PRETTY=1/true (local dev). Useful in tests
   * (which pass false). See docs/logging.md §3.
   */
  pretty?: boolean;
};

// Paths whose values are replaced with "[REDACTED]" if they ever appear in a
// logged object. Defence-in-depth behind the primary discipline rule of never
// passing secret values to the logger at all. See docs/logging.md §4.
const REDACT_PATHS = [
  // Auth headers anywhere in a logged object (top-level + nested .headers)
  "headers.authorization",
  "*.headers.authorization",
  "req.headers.authorization",
  "headers['x-api-key']",
  "*.headers['x-api-key']",
  // Named secret fields if a config/env object is ever logged
  "HA_TOKEN",
  "*.HA_TOKEN",
  "UNIFI_API_KEY",
  "*.UNIFI_API_KEY",
  "WIFI_PASSWORD",
  "*.WIFI_PASSWORD",
  "SPOTIFY_CLIENT_SECRET",
  "*.SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_REFRESH_TOKEN",
  "*.SPOTIFY_REFRESH_TOKEN",
  "SPOTIFY_ACCESS_TOKEN",
  "*.SPOTIFY_ACCESS_TOKEN",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "OPENROUTER_API_KEY",
  "*.OPENROUTER_API_KEY",
  "GITHUB_ACTIONS_TOKEN",
  "*.GITHUB_ACTIONS_TOKEN",
  "DATABASE_URL",
  "*.DATABASE_URL",
  "POSTGRES_PASSWORD",
  "*.POSTGRES_PASSWORD",
  "OP_SERVICE_ACCOUNT_TOKEN",
  "*.OP_SERVICE_ACCOUNT_TOKEN",
  "GHCR_PULL_TOKEN",
  "*.GHCR_PULL_TOKEN",
  // Resolved-secret shapes carry the cleartext under `resolvedValue` or a
  // re-wrapped `{ dockerName, value }`, both keys must be censored.
  "resolvedValue",
  "*.resolvedValue",
  "value",
  "*.value",
  "apiToken",
  "*.apiToken", // Cloudflare token
  // Generic wrapper-key catch-all, brittle-insurance behind layer-1 discipline.
  "token",
  "*.token",
  "secret",
  "*.secret",
  "password",
  "*.password",
  "credential",
  "*.credential",
  // Private home location (no-home-address guard territory)
  "HOME_LAT",
  "*.HOME_LAT",
  "HOME_LON",
  "*.HOME_LON",
  "HOME_PLACE_NAME",
  "*.HOME_PLACE_NAME",
  // Camera RTSP credentials + LAN coordinates. They only ever live inside the
  // go2rtc config Secret, but if a vault/config object is ever logged (Pulumi)
  // these must never reach a log line , the RTSP URL embeds the password inline.
  "EUFY_BEDROOM_CAM__HOST",
  "*.EUFY_BEDROOM_CAM__HOST",
  "EUFY_BEDROOM_CAM__RTSP_USERNAME",
  "*.EUFY_BEDROOM_CAM__RTSP_USERNAME",
  "EUFY_BEDROOM_CAM__RTSP_PASSWORD",
  "*.EUFY_BEDROOM_CAM__RTSP_PASSWORD",
];

// Process-wide root logger, set by createLogger(), read by getLogger().
// Module-global is intentional and the ONLY exception to the "no module-global
// mutable state" rule: this singleton is the entire purpose of this module.
let _root: Logger | null = null;

/**
 * Build the ROOT logger for a process. Call EXACTLY ONCE per service at
 * startup and pass the instance down (or access via getLogger). Binds
 * { service, env } on every line, installs redaction, and selects raw JSON
 * (default) vs pino-pretty (LOG_PRETTY=1, via a bundle-safe sync stream).
 */
export function createLogger(opts: CreateLoggerOptions): Logger {
  // Bound env LABEL. APP_ENV is read live (NODE_ENV is baked into bundles, so it
  // would mislabel prod as "development"); default to "development" locally.
  const env = opts.env ?? process.env.APP_ENV ?? "development";

  // Pretty vs JSON. Default is JSON, the bundle-safe, prod-correct path. Opt
  // INTO pretty with LOG_PRETTY=1 (local dev / tilt), never via NODE_ENV.
  const usePretty =
    opts.pretty !== undefined
      ? opts.pretty
      : process.env.LOG_PRETTY === "1" || process.env.LOG_PRETTY === "true";

  // Level: explicit opt > LOG_LEVEL env > "debug" when pretty (dev), else "info".
  const level = opts.level ?? process.env.LOG_LEVEL ?? (usePretty ? "debug" : "info");

  const baseOptions: pino.LoggerOptions = {
    level,
    base: { service: opts.service, env },
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  };

  // Sync pino-pretty stream (NOT pino.transport) so bundled services never spawn
  // a thread-stream worker that can't resolve in a single-file bundle. www-rw07.
  const logger = usePretty
    ? pino(baseOptions, prettyStream({ translateTime: true }))
    : pino(baseOptions);

  _root = logger;
  return logger;
}

// Last emission per change-log key: the signature that was logged and when.
// Bounded by the number of distinct keys the callers use (one per managed
// entity), i.e. tens of rows, not unbounded cardinality , keys must therefore
// be entity-scoped identifiers, never something per-request or per-tick.
const _lastChange = new Map<string, { signature: string; at: number; repeats: number }>();

/** How long an unchanged state waits before it re-announces itself. */
const DEFAULT_REPEAT_AFTER_MS = 15 * 60_000;

export type LogChangeOptions = {
  /**
   * Re-emit an unchanged line after this long so a stuck state stays visible
   * in a log tail instead of going silent forever. Defaults to 15 minutes.
   */
  repeatAfterMs?: number;
  /**
   * Level to emit at. `info` (default) for a normal state change; `warn` for a
   * degraded-but-expected state that a fast loop would otherwise repeat
   * forever. Never below info , that is the point of this module.
   */
  level?: "info" | "warn" | "error";
};

/**
 * Emit an `info` line ONLY when its content changed since the last call for
 * the same `key` (or when `repeatAfterMs` has elapsed). This is how a 1s
 * reconcile loop logs its decisions at `info` without writing 86,400 lines a
 * day: the interesting event is "the enforcer started pushing this light",
 * not the 3,600 identical follow-up ticks.
 *
 * A re-announced or changed line carries `repeats`, the number of suppressed
 * identical cycles since it was last printed, so a stuck enforcer is
 * self-evident ("repeats: 3421") rather than invisible.
 *
 * `key` must be entity-scoped (e.g. `light-push:light.desk`), never
 * per-request , see the bound on `_lastChange` above.
 */
export function logChange(
  log: Logger,
  key: string,
  fields: Record<string, unknown>,
  msg: string,
  opts: LogChangeOptions = {},
): void {
  const signature = JSON.stringify(fields);
  const now = Date.now();
  const previous = _lastChange.get(key);
  const repeatAfterMs = opts.repeatAfterMs ?? DEFAULT_REPEAT_AFTER_MS;

  if (previous && previous.signature === signature && now - previous.at < repeatAfterMs) {
    previous.repeats += 1;
    return;
  }

  const repeats = previous?.signature === signature ? previous.repeats : 0;
  _lastChange.set(key, { signature, at: now, repeats: 0 });
  log[opts.level ?? "info"](repeats > 0 ? { ...fields, repeats } : fields, msg);
}

/**
 * Forget a change-log key (or all of them) so the next `logChange` emits.
 * Call when the underlying state stops existing , e.g. a device goes
 * unreachable , so its return is logged as a fresh event rather than being
 * suppressed as "unchanged". Also the reset hook for tests.
 */
export function resetChangeLog(key?: string): void {
  if (key === undefined) _lastChange.clear();
  else _lastChange.delete(key);
}

/**
 * Process-wide accessor. createLogger() registers the root; getLogger()
 * returns it. Throws if called before createLogger, a hard signal that a
 * module logged before the process initialized its logger (no silent
 * default root). Used by shared @control-center/api domain services that run under
 * multiple process roots (api + worker). See docs/logging.md §2.
 */
export function getLogger(): Logger {
  if (_root === null) {
    throw new Error(
      "@www/logger: getLogger() called before createLogger(). " +
        "Call createLogger({ service }) once at process startup.",
    );
  }
  return _root;
}
