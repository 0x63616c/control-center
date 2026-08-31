# Structured logging (www-rw07)

Status: **implemented** (www-rw07). Foundation (`@repo/logger`) + the backend services shipped in www-rw07.1. Library: **pino**. (bosun was a 4th consumer at the time; it has since been replaced by Pulumi + k8s and removed. `media-worker` below was also a consumer at rollout time but does not exist in this repo today — the current backend consumers are api and worker only.)

This document is the contract for adopting structured logging across the
control-center **backend** (api, worker, and historically media-worker — see
above). The web app is explicitly out of scope (see §9). Read this before
writing any logging code or adding a `console.*` call to a backend service.

---

## 1. Where the shared logger lives

**Decision: a new `packages/logger` workspace, published as `@repo/logger`.**

Rejected alternatives and why:

- **A module inside `@control-center/api`** (e.g. `api/src/logger.ts`). `bosun`
  (`@bosun/bosun`) deliberately has **no `@control-center/api` dependency** and must never
  gain one, it is a deploy agent that ships in its own image and would drag the
  entire tRPC/drizzle/pg tree into bosun's bundle. So the logger cannot live
  under api.
- **Duplicated config per service** (each app configures pino itself). That
  reproduces the redaction list and the dev/prod format switch in four places ,
  guaranteed drift, and a redaction path missed in one copy leaks a secret. The
  whole point is one place that defines "never log secrets".

`packages/logger` is the only option that **all four consumers can import with no
cross-app coupling and no cycles**:

```
@control-center/api        ─┐
@control-center/worker      ├─▶ @repo/logger   (leaf; depends only on pino + pino-pretty)
@control-center/media-worker┤
@bosun/bosun     ─┘
```

`@repo/logger` depends on nothing in the repo. api/worker/media-worker already
depend on `@control-center/api`; they add a direct dep on `@repo/logger`. bosun adds
`@repo/logger` as its **first and only** `@repo/*`/`@bosun/*` cross-workspace dep
(a leaf logger, not the app tree, acceptable). No cycle is possible because the
logger imports nothing back.

**Package shape:**

```
packages/logger/
  package.json        # name "@repo/logger", type module, deps: pino, pino-pretty
  src/index.ts        # the public API (exports below)
  test/redact.test.ts # asserts secrets are scrubbed
```

```jsonc
// packages/logger/package.json
{
  "name": "@repo/logger",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": { "pino": "^9", "pino-pretty": "^13" },
  "devDependencies": { "@types/bun": "^1.3.13", "typescript": "^5.9.3", "vitest": "^3.2.4" }
}
```

**knip-cleanliness rules for this package:**

- `pino` AND `pino-pretty` are both normal import edges, knip sees them. We
  import `pino-pretty` directly as a **synchronous stream factory**
  (`import prettyStream from "pino-pretty"`), NOT as a `pino.transport` target
  string. This is deliberate: a transport target spawns a `thread-stream` worker
  that re-resolves `"pino-pretty"` from a file path which does not exist inside a
  bun single-file bundle, so the bundled api/worker/media-worker crash-looped on
  boot (www-rw07). A sync stream is bundled inline and works everywhere, and as a
  bonus needs no `knip.jsonc` ignore (the import edge satisfies knip on its own).
- `createLogger` and `getLogger` are both consumed by real call sites (see §2:
  `getLogger()` is the accessor for deep `@control-center/api` domain code), so they are
  live exports, no `@public` tag needed. The `Logger` type alias is exported for
  consumers' convenience with no internal use, so it gets a
  `/** @public, re-exported Logger type for service call sites */` tag.
- Add the `packages/logger` workspace block to `knip.jsonc` (`"test/**/*.test.ts"`
  entries; `src/index.ts` is auto-detected from `exports`).
- **Closing the foundation ticket requires `bunx knip` clean run from within
  `packages/logger`**, not only the root run, make that an explicit AC.

---

## 2. API surface

One factory, one child pattern, standard bound fields. Pino is the engine; we
expose a **narrow, stable** wrapper so call sites never touch pino config and we
can swap internals later.

```ts
// packages/logger/src/index.ts
import pino, { type Logger as PinoLogger } from "pino";

/** @public, Logger type used at every service call site. */
export type Logger = PinoLogger;

export type CreateLoggerOptions = {
  /** Service name bound on every line, e.g. "api" | "worker" | "media-worker" | "bosun". */
  service: string;
  /** Environment string, bound on every line. Defaults to APP_ENV ?? "development". */
  env?: string;
  /** Explicit level override. Defaults to LOG_LEVEL env, else "debug" (pretty) / "info" (JSON). */
  level?: string;
  // NOTE: the level FLOOR here is about what the sink passes through, including
  // third-party pino output. It does not license our own code to log at debug ,
  // the exported Logger type has no debug method. See "the no-debug rule" in §3.
  /** Force pretty/JSON. Omitted → JSON, opting into pretty only on LOG_PRETTY=1. */
  pretty?: boolean;
};

/**
 * Build the ROOT logger for a process. Call EXACTLY ONCE per service at startup
 * and pass the instance down (or stash via getLogger). Binds { service, env }
 * on every line, installs redaction, and selects JSON (default) vs pino-pretty
 * (LOG_PRETTY=1, via a bundle-safe sync stream).
 */
export function createLogger(opts: CreateLoggerOptions): Logger;

/**
 * Process-wide accessor. createLogger() registers the root; getLogger() returns
 * it. Throws if called before createLogger, a hard signal that a module logged
 * before the process initialised its logger (no silent default root).
 */
export function getLogger(): Logger;
```

**`getLogger()` is the accessor for shared `@control-center/api` domain code, and only it.**
Two patterns coexist, chosen by where the code physically lives:

- **Threaded instance**, the default for code a process owns directly:
  `server.ts` (api), `index.ts` + `runtime.ts` (worker / media-worker, where the
  `Logger` is an explicit constructor arg, no module-global), and `cli.ts` /
  `serve.ts` (bosun). These create the root and pass children down.
- **`getLogger()`**, for the **shared `@control-center/api` domain services**
  (`jobs/queue.ts`, controls-service, the
  enforcers). This code is imported and run under **two different process roots**
  (the `api` server AND the `media-worker`), so it cannot demand a threaded
  logger from a single owner without one of the two roots being unable to reach
  it. It calls `getLogger()`, which returns **whichever root the live process
  created**, so the same line binds `service: "api"` when the api runs it and
  `service: "media-worker"` when the media-worker runs it. That is exactly the
  behaviour we want, and is why `getLogger()` earns its place rather than being
  dead API (it has real consumers, so knip stays green without a `@public` lie).

Because the only legitimate `getLogger()` callers are these shared domain
modules, `getLogger()` is never called from `worker`'s own `runtime.ts` (that
copy is worker-owned and takes the threaded arg).

**Child loggers carry context**, never thread fields by hand into each message.
`pino`'s `.child()` is the mechanism; we standardise the call sites:

```ts
// per-request (api), bind a request id + method/path once:
const reqLog = log.child({ reqId, method, path });
reqLog.info({ status, durationMs }, "request completed");

// per-worker (worker / media-worker runtime), bind the worker name once:
const workerLog = log.child({ worker: worker.name });
workerLog.error({ err, consecutiveFailures, durationMs }, "worker cycle failed");

// per-deploy (bosun), bind a deploy/correlation id:
const deployLog = log.child({ deployId, stack: stackName });
```

**Standard bound fields** (always present, set by `createLogger` + the child
patterns above):

| field        | bound by         | meaning                                             |
|--------------|------------------|-----------------------------------------------------|
| `service`    | `createLogger`   | `api` / `worker` / `media-worker`                   |
| `env`        | `createLogger`   | `production` / `development` / `test`               |
| `reqId`      | request child    | per-request correlation (api)                       |
| `worker`     | worker child     | which loop emitted the line                         |
| `durationMs` | per call         | timing on any measured operation                    |

Errors are passed as `log.error({ err }, "msg")`, pino's standard `err`
serializer renders `message` + `stack`. Never `JSON.stringify(err)` (drops the
stack) and never interpolate the error into the message string.

### `installFatalHandlers(log)`, process-level crash visibility

```ts
export function installFatalHandlers(log: Logger): void;
```

Registers process-wide `uncaughtException` / `unhandledRejection` handlers.
Each logs `log.fatal({ err }, "uncaught exception" | "unhandled rejection")`
(via pino's `err` serializer, so message + stack render, with a non-`Error`
`unhandledRejection` reason normalized to an `Error` first) and then calls
`process.exit(1)`. `fatal` is above `error` and therefore visible at the prod
`info` default (§3). This does not change process behavior beyond logging ,
the process still exits non-zero so k8s/Swarm restarts the pod , it exists
solely so the crash-loop leaves a structured line explaining why, instead of
silence.

Call it once per process, immediately after building the root logger:
`api`'s `server.ts` and `worker`'s `index.ts` both do this. It is deliberately
**not** invoked from inside `createLogger()` itself, since `createLogger()`
also runs in contexts (tests, tooling) that must not install process-level
handlers , any future backend entrypoint must call it explicitly at its own
startup.

---

## 3. Format and levels

**Format defaults to JSON; pretty is an explicit opt-in. Decided once in `createLogger`:**

- **Default → raw pino JSON** to stdout (one object per line), the shape
  `docker service logs control-center_<svc>` ships and any aggregator parses.
  This is the production path and the safe default.
- **`LOG_PRETTY=1` (or `true`) → `pino-pretty`** (coloured, human single line,
  `translateTime`), rendered via a **synchronous stream** (`pino(opts, prettyStream(...))`),
  NOT a `pino.transport`. Set it in `tilt` / local dev for readable logs.

**Why not `NODE_ENV`?** The api/worker/media-worker ship as **bun single-file
bundles**, and bun **inlines `process.env.NODE_ENV` to a build-time literal**.
CI builds the bundle without `NODE_ENV=production`, so a `NODE_ENV` check freezes
to "not production" and ignores the container's runtime env. The first cut keyed
pretty/JSON on `NODE_ENV` and crash-looped all three services in prod (the
transport's `thread-stream` worker can't resolve `pino-pretty` inside a bundle →
`ModuleNotFound`). So format is keyed on **`LOG_PRETTY`** (read live, never baked)
and pretty uses a **sync stream** so it can't spawn a worker even if enabled in a
bundle. www-rw07.

**bosun** passes an explicit `pretty: false` to `createLogger` and so always
emits JSON regardless of env.

**The env LABEL uses `APP_ENV`, not `NODE_ENV`.** Because `NODE_ENV` is baked
into the bundle it can't carry the runtime environment into the logs, so the
bound `env` field defaults from `process.env.APP_ENV ?? "development"`;
`deploy.config.ts` sets `APP_ENV=production` on the deployed services.

**Level and env defaulting are resolved in ONE place: `packages/logger`.** All
`process.env` reads for the logger (`LOG_LEVEL`, `LOG_PRETTY`, `APP_ENV`) live
**inside `packages/logger/src/index.ts`**, `createLogger` reads
`process.env.LOG_LEVEL` (else `debug` when pretty / `info` for JSON) and defaults
`env` from `process.env.APP_ENV ?? "development"` when `opts.env` is omitted. Call
sites **never** read these themselves; they pass an optional `level` / `env` /
`pretty` through `createLogger` opts if they need to override.

This matters for the lint gate: biome's `style.noProcessEnv` is `error`
repo-wide and only disabled (in `biome.json` overrides) for `api/src/env.ts`,
`packages/bosun/src/cli.ts`, and `scripts/**`. A `process.env.LOG_LEVEL` read in
`server.ts`, the worker/media-worker `index.ts`, or bosun `serve.ts` would fail
`bunx biome check .` (a hard gate). Centralising the reads in `packages/logger`
keeps every other call site env-free, and the foundation ticket adds a biome
override block for `**/packages/logger/src/**` with `style.noProcessEnv: off`
(same pattern as the existing `env.ts` / `cli.ts` overrides) so the one file that
does read env is sanctioned.

`LOG_LEVEL: z.string().optional()` is still added to the api env schema for
documentation/validation, but the logger reads `process.env.LOG_LEVEL` directly
(it cannot import the api env schema, it is a leaf with no `@control-center/api` dep).

**Levels policy** (the rule every gap in §5 maps onto):

| level   | use for                                                                                          |
|---------|--------------------------------------------------------------------------------------------------|
| `error` | an operation was **lost** or a loop/process is degraded: permanently-failed job, no-handler, worker cycle threw, top-level fatal, enforcer/sync cycle failure. Pages-worthy. |
| `warn`  | recoverable / retried / degraded-but-serving: HA non-2xx, job retry scheduled, command timeout, DB read fell back to "unavailable", missing optional secret (enrichment skipped), 404 webhook, malformed override arg. |
| `info`  | lifecycle + business outcomes an operator wants in steady state: startup line, shutdown, migrations start/done, request completed (api), job claimed/completed, secrets/routes reconcile summary, deploy timing, worker failure→recovery transition. |
| `debug` | **NEVER USED BY OUR CODE.** Reserved for libraries we don't own. See the rule below. |

### The no-debug rule

**Every line WE write is `info` or above.** `debug` is not a level our code
emits at, it is reserved for code we do not own (pino internals, drizzle, node
HTTP clients).

Why: raising `LOG_LEVEL=debug` to read our own diagnostics also unmutes every
third-party library logging through the same pino root. That is noise we did not
ask for and cannot tune per-source, so in practice the flag never gets flipped
and any line parked at `debug` is a line that is never read. A diagnostic that
is invisible at the default level does not exist.

So `LOG_LEVEL` stays at `info` in prod permanently. If it is ever raised, that is
to inspect a LIBRARY, not ourselves.

**The corollary , this is the part that takes work.** A line that would be too
noisy at `info` does not get demoted to `debug`; it gets made to fire LESS:

- **Per-tick reconcile decisions** (the 1s enforcer loops) use `logChange()` from
  `@www/logger`: emit only when the logged content CHANGES for a given key, and
  re-announce an unchanged state every 15 min carrying a `repeats` count. The
  event is "the enforcer started pushing this light", not the 3,600 identical
  follow-up ticks. A stuck enforcer still shows up , as `repeats: 3421`.
- **Periodic heartbeats** (worker stats) use a wall-clock interval, so cadence
  tracks the operator's need, not the worker's tick rate.
- **Pure transport chatter** with no signal (a 2xx CORS preflight, a per-request
  "ok" inside a 10s poll) is **not logged at all**. Only its failing or
  degraded case is (`warn` on a rejected preflight, on a slow-but-successful
  call).

**Enforcement is type-level, not lint-level.** `@www/logger`'s exported `Logger`
type omits `debug` and `trace`, so `log.debug(...)` is a compile error at every
call site. `packages/logger/test/change-log.test.ts` pins this with
`@ts-expect-error` (the logger tsconfig includes `test/`, so it is checked).

---

## 4. Redaction, secrets are NEVER logged

Two layers, defence in depth:

1. **Discipline (primary):** resolved secret values, tokens, and `Authorization`
   header values are **never passed to the logger at all**. Log the *ref/key/name*,
   the *status code*, the *duration*, never the value. bosun logs `op://` ref
   paths and **hashed docker secret names**, never `resolvedValue`. This is the
   rule the §5 per-service notes enforce ("keys only, never values").
2. **`pino redact` (backstop):** in case a secret-bearing object is ever logged
   by accident, `createLogger` installs a redaction path list that replaces the
   value with `[REDACTED]`. Backstop, not a licence to log secret objects.

> **Redaction is key-NAME-based, not value-based.** pino `redact` matches by
> exact path / key name, so a secret logged under a key the list does not name
> (e.g. bosun wraps `resolvedValue` into a generic `{ name, value }` shape in
> `reconcile/secrets.ts`, or an HA token logged inside a config dump under key
> `token`) slips straight through. Path-based redaction is brittle against
> renamed / wrapped fields. **Therefore layer 1 (discipline, never pass the
> value) is load-bearing, not optional**, and the list below adds a generic
> catch-all of common wrapper key names on top of the named secrets.

```ts
const REDACT_PATHS = [
  // auth headers anywhere in a logged object (top-level + nested .headers)
  "headers.authorization", "*.headers.authorization", "req.headers.authorization",
  "headers['x-api-key']", "*.headers['x-api-key']",
  // named secret fields if an object carrying config is ever logged
  "HA_TOKEN", "*.HA_TOKEN",
  "UNIFI_API_KEY", "*.UNIFI_API_KEY",
  "WIFI_PASSWORD", "*.WIFI_PASSWORD",
  "SPOTIFY_CLIENT_SECRET", "*.SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_REFRESH_TOKEN", "*.SPOTIFY_REFRESH_TOKEN",
  "SPOTIFY_ACCESS_TOKEN", "*.SPOTIFY_ACCESS_TOKEN",
  "accessToken", "*.accessToken", "refreshToken", "*.refreshToken",
  "OPENROUTER_API_KEY", "*.OPENROUTER_API_KEY",
  "DATABASE_URL", "*.DATABASE_URL",
  "POSTGRES_PASSWORD", "*.POSTGRES_PASSWORD",
  "OP_SERVICE_ACCOUNT_TOKEN", "*.OP_SERVICE_ACCOUNT_TOKEN",
  "GHCR_PULL_TOKEN", "*.GHCR_PULL_TOKEN",
  // generic secret-plaintext wrapper keys: a resolved secret value can ride a
  // renamed/wrapped key, so both common shapes are censored as defence-in-depth.
  "resolvedValue", "*.resolvedValue",
  "value", "*.value",
  "apiToken", "*.apiToken",                       // Cloudflare token
  // generic wrapper-key catch-all, a secret logged under a renamed/wrapped key
  // (the brittleness called out above). Cheap insurance behind layer-1 discipline.
  "token", "*.token", "secret", "*.secret",
  "password", "*.password", "credential", "*.credential",
  // private-but-not-credential home location (no-home-address guard territory)
  "HOME_LAT", "*.HOME_LAT", "HOME_LON", "*.HOME_LON",
  "HOME_PLACE_NAME", "*.HOME_PLACE_NAME",
];
```

> `REDACT_PATHS` was finalised against the real field names, including the
> generic secret-value wrapper keys (`resolvedValue`, `value`) so a value logged
> under a renamed/wrapped key is still censored. The api config shapes were
> verified the same way.

`createLogger` passes `{ redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }`
to pino. A `packages/logger/test/redact.test.ts` asserts each sensitive field is
censored, that test is the machine-checkable AC for the foundation ticket. The
test asserts against objects shaped like a resolved secret
(`{ name, ref, resolvedValue }`) and its `{ name, value }` re-wrap, and the
api config object, not just bare `{ HA_TOKEN: … }`, so the named-field and
wrapper-key paths are both exercised against the shapes that actually flow.

**Sensitive field inventory** (union across services): `HA_TOKEN`,
`UNIFI_API_KEY`, `WIFI_PASSWORD`, `SPOTIFY_CLIENT_SECRET`,
`SPOTIFY_REFRESH_TOKEN`, `SPOTIFY_ACCESS_TOKEN`, `OPENROUTER_API_KEY`,
`DATABASE_URL`, `POSTGRES_PASSWORD`,
`OP_SERVICE_ACCOUNT_TOKEN`, `GHCR_PULL_TOKEN`, Cloudflare `apiToken`, any
`Authorization` / `X-API-KEY` header value, a resolved-secret `resolvedValue`, and the
private home fields `HOME_LAT` / `HOME_LON` / `HOME_PLACE_NAME`. The gitleaks +
no-home-address pre-commit guards remain the commit-time backstop.

---

## 5. Per-service adoption

Every backend service does the same two things: (a) replace existing `console.*`
with `getLogger()`/child loggers at the mapped level, and (b) fill the named
observability gaps. The single highest-value change is the **worker/media-worker
runtime**, which today swallows every cycle error into invisible in-memory stats.

> **Shared-code ownership, these tickets are NOT fully parallel on shared files.**
> The job queue, controls-service, and the
> enforcers physically live in **`@control-center/api`** and are run by **two** process
> roots (the api server and the media-worker). To avoid parallel worktrees both
> editing `jobs/queue.ts` and conflicting on every merge,
> **ALL `@control-center/api` domain-service logging is owned by the API ticket only.**
> Those modules acquire their logger via **`getLogger()`** (see §2) so they bind
> whichever root is live (`service: "api"` under the api, `service: "media-worker"`
> under the media-worker), no threaded arg, reachable from both roots. The
> worker and media-worker tickets are therefore reduced to **only their own
> `runtime.ts` + `index.ts`** (the framework copies they each own). The API
> ticket must land the shared-code logging FIRST; worker / media-worker then
> adopt only the runtime. See the rollout note in §8.

### api (`@control-center/api`)

Root logger created once in `server.ts`: `const log = createLogger({ service: "api" })`.
This ticket **owns all `@control-center/api` domain-service logging** (queue,
controls, enforcers, see the §5 ownership note); those modules log via
**`getLogger()`** so they also bind correctly when the media-worker runs them.
`server.ts`-owned code uses the threaded `log` / `reqLog` children directly.

**Replace:**
- `server.ts:53` tRPC onError `console.error` → `reqLog.error({ err, path }, "trpc error")`.
- `server.ts:76` 500 `console.error` → `reqLog.error({ err, status: 500, durationMs }, "request failed")`.
- `server.ts:82` per-request `console.warn` → **`reqLog.info({ status, durationMs }, "request completed")`** for real methods (it was mis-levelled at warn for 200s; completed requests are `info`). **A SUCCESSFUL CORS `OPTIONS` preflight is not logged at all** (transport noise, always the same 2xx, would roughly double the line count); a preflight returning >=400 is a `warn` ("cors preflight rejected"), since a broken preflight breaks every request behind it. Build `reqLog = log.child({ reqId, method, path })` at the top of `fetch()`.
- `server.ts:87` startup `console.warn` → `log.info({ port, env }, "api started")`.
- `party-service.ts:131` `console.error("Transient HA error…")` → `log.error({ err, tick, speed }, "party engine tick failed")` (now carries the real error).
- `db/seed.ts` console.* → `info`/`error` (seed-only, low priority but keep consistent).

**Add (new structured logs):**
- `db/migrate.ts`, `info` migrations start (folder) + `info` done / `error` on throw.
- `env.ts` hydrate path, `info` which secret-file vars resolved vs left default (**names only, never values**).
- `/health/climate` route, `info` HA probe latency + ok/fail.
- `trpc/init.ts` `haErrorMiddleware`, `warn` with tRPC path, original `HaError.status`, message (preserve the HTTP status lost in the remap).
- `integrations/homeassistant/index.ts` `request()` catch, `warn` HA path, status (0 = network), `durationMs` on every non-2xx/timeout (single HA I/O chokepoint).
- `device-sync-service.ts`, `light-enforcer-service.ts`, `climate-enforcer-service.ts`, `error` on cycle catch / `markHeartbeat(error)` with message + `consecutiveFailures`.
- `light-enforcer-service.ts applyDecision`, `logChange` (info) per push (entityId, on/off, brightness, **colour as kelvin/rgb tuple only**) and per adopt (entityId, adopted reported state), keyed `light-push:<entityId>` / `light-adopt:<entityId>` so a stuck 1s push is one line + `repeats`, not a flood.
- `device-sync-service.ts sweepExpiredWindows`, `warn` on command marked Timeout (deviceId, entityId, desired, elapsed).
- `jobs/queue.ts`, `error` no-handler; `warn` retry (jobId, type, attempt, delaySec, err); `error` permanent failure (jobId, type, attempts, err); plus `claimAndRun` `info` claimed (jobId, type, attempts) / `info` completed (jobId, type, durationMs) / queue-empty NOT logged (a queue that is empty is the normal case and carries no signal) (these fire under BOTH the api and media-worker roots via `getLogger()`).
- `integrations/spotify/client.ts refreshToken`, `info` success with `expires_in` (**never the token**). Hourly, so `info` is cheap.
- `controls-service.ts`, `warn` getControlsState DB-read failure (devices appear unavailable); `warn` writeDesired per-entity DB write failure (entityId, desired).

> All of the above `@control-center/api` domain modules acquire their logger via
> `getLogger()` (§2), so each line binds whichever process root is live.

### worker (`@control-center/worker`)

Root logger `createLogger({ service: "worker" })` in `index.ts`. **The runtime
change is the heart of this whole effort**, `runtime.ts` currently catches every
cycle error into `stats` and emits nothing.

**Replace:**
- `index.ts` startup `console.warn` → `log.info({ workers: [...] }, "worker started")`.
- `index.ts` signal `console.warn` → `log.info({ signal }, "worker stopping")`.

**Add, `runtime.ts` is passed a `Logger` and binds a child per worker:**
- **cycle catch** → `workerLog.error({ err, consecutiveFailures, durationMs }, "worker cycle failed")`. Fixes the invisible-failure bug.
- **failure transition** (`consecutiveFailures` 0→1) → distinct `error` "worker entered failing state" so the exact onset is greppable.
- **recovery transition** (`consecutiveFailures` >0→0) → `info` "worker recovered" with the streak length just cleared.
- **start()** → `info` per worker registered (name, intervalMs, runOnStart).
- **stop()** → `info` timers cleared, which workers had an in-flight timer.
- **periodic stats** → `info` snapshot (totalRuns, consecutiveFailures, lastDurationMs) on a 5-minute WALL-CLOCK interval (`STATS_INTERVAL_MS`), staggered per worker. Not every-N-runs: that tied cadence to tick rate, so a 1s worker snapshotted 60x more often than a 60s one.
- **slow-cycle** (lastDurationMs > intervalMs) → `warn` (name, lastDurationMs, intervalMs, ratio).
- `index.ts` after `runMigrations()` → `info` migrations done / `error` on throw.
- SIGINT/SIGTERM handler → `info` final per-worker stats snapshot at shutdown.

The runtime takes the logger as a **constructor argument** (`createWorkerRuntime(workers, { logger })`), no module-global logger, keeps it testable, and lets media-worker pass its own `service: "media-worker"` root.

### media-worker (`@control-center/media-worker`)

Root logger `createLogger({ service: "media-worker" })` in `index.ts`. It owns a
**copy** of the worker framework (`runtime.ts`/`types.ts`), apply the same
runtime changes as worker (failure/recovery transitions, periodic stats,
slow-cycle). **This ticket is scoped to the files media-worker OWNS only**
(`index.ts` + its `runtime.ts`/`types.ts` copy). The job queue lives in
`@control-center/api` and its logging is owned by the **API ticket**
(§5 ownership note) via `getLogger()`, those lines fire automatically under the
`media-worker` root at runtime, so this ticket neither edits nor re-logs them.

**Replace:**
- `index.ts:100` startup + `index.ts:108` signal → `info`.

**Add (media-worker-owned files only):**
- runtime cycle catch / 3+ streak → `error` (same runtime changes as worker, above).
- `index.ts` migrations start/done.

> **History.** A `### bosun` per-service section lived here when the deploy tool was
> an in-repo service that logged through `@repo/logger`. bosun has been replaced by
> Pulumi + k8s (`infra/`) and that section is gone with the package. Deploy logging is
> now Pulumi's own output / `kubectl logs`, outside this contract.

---

## 6. How we know it's working

Each service emits, in `kubectl logs deploy/<svc>`, a single
unmistakable **startup line** and ongoing **steady-state** lines. An operator
greps the startup line first (timestamp anchor), then watches the steady-state
stream to confirm liveness:

| service        | startup line                              | steady-state visible at `info`                                   |
|----------------|-------------------------------------------|------------------------------------------------------------------|
| api            | `"api started" {port,env}`                | `"request completed" {status,durationMs}` per request            |
| worker         | `"worker started" {workers:[…]}`          | failure→recovery transitions; enforcer decision CHANGES; 5-min stats snapshot |
| media-worker   | `"media-worker started" {workers:[…]}`    | `"job claimed"`/`"job completed"` cycle summaries                |

Liveness contract:
- **Startup line present** → process booted and configured its logger.
- **Failure-transition + recovery lines** (worker/media-worker) → a degraded
  loop is now *visible in stdout*, not buried in `stats()`. This is the bug §5
  fixes; the AC for the worker tickets asserts these lines exist.
- **`info` is the prod default and everything we write is visible there.**
  There is no "turn on debug during an incident" step, because there is nothing
  of ours parked below `info` , see the no-debug rule in §3.

**Expected `info`-volume / log-rate (so an operator isn't surprised):** the api
logs `"request completed"` at `info` on **every** request through the single
`fetch()` chokepoint. On a kiosk dashboard the steady-state driver is per-tile
polling plus the tRPC client, whose `QueryClient` **retries infinitely** (per
project CLAUDE.md), so:

- **Successful CORS `OPTIONS` preflights are not logged** , pure transport
  noise that would otherwise roughly double the line count. Only the real
  method's completion is an `info` liveness line (plus a `warn` for a preflight
  that actually failed).
- During an HA / backend outage the infinite-retry `QueryClient` must NOT spin a
  tight error-retry loop that floods `"request failed"` at `error`. The api's
  per-tile reads fail fast and the client backs off; confirm the retry cadence is
  bounded (React Query's exponential backoff caps the interval) so an outage
  produces a steady trickle, not an error storm. If any path retries with no
  backoff, that is a bug to fix before adopting `error` on it.
- Document the **expected steady-state req/s** (tiles × poll interval) in this
  section once measured, so the `info` rate is a known quantity.

The **1s worker loops stay silent** in steady state , not because their lines
are parked at `debug`, but because `logChange` makes them fire on transitions
only, plus the 5-minute stats snapshot. That is the correct bound on the
highest-frequency emitters.

### Reading them from a desk: Loki (added 2026-07-26, #216)

`kubectl logs` is still the fastest read for a pod you already have in front of
you, but stdout is no longer the only place these lines live. Grafana Alloy runs
as a DaemonSet in the `observability` namespace and streams every container's
stdout/stderr — from the Kubernetes pod-log API, the same endpoint `kubectl logs
-f` reads — into Loki. Query it in Grafana
(`https://grafana.worldwidewebb.co`, Explore → Loki). Retention is 14 days.

The pipeline understands **this contract's** JSON specifically. Alloy runs a
`stage.json` over each line pulling out pino's own field names — numeric `level`,
message `msg`, epoch-millis `time`, plus the `service` and `env` base fields
bound by `packages/logger` (§1) — then:

- **`level` is translated from pino's number to a word.** pino writes `30`/`50`;
  a `{level="30"}` label means nothing to anyone, so a `stage.template` maps
  10/20/30/40/50/60 to `trace`/`debug`/`info`/`warn`/`error`/`fatal`.
- **The application's own `time` is used as the log timestamp**, not the moment
  Alloy read the line, so a backlogged collector cannot stamp an hour-old line
  with the wrong time.

Labels available to query, and nothing else:

| label | from |
|-------|------|
| `namespace`, `pod`, `container` | Kubernetes metadata |
| `app` | the pod's `app.kubernetes.io/name` or `app` label |
| `service` | this contract's `service` base field (`api`, `worker`, …) |
| `level` | the mapped pino level |

```logql
{namespace="control-center", service="api", level="error"}
{namespace="control-center", service="worker"} | json | msg =~ "job .*"
```

Only `service` and `level` are promoted from the log body, and both are bounded
— by the number of services we deploy and by the six pino levels. **Every other
field stays in the JSON line and is filtered at query time with `| json`.**
Promoting an unbounded field (request id, device id, URL path) to a label
creates one Loki stream per value and destroys the install; see
`docs/observability.md` §6 before adding a third promotion.

Lines that are not JSON — third-party images — extract nothing and arrive
unlabelled. They are still there, just without `service`/`level`. Which is one
more reason §3's "everything of ours is JSON at `info`" holds.

---

## 7. Web (browser), shipped separately

`web` was **not** part of this effort, and is now covered by its
own stack in `web/src/lib/log/` (design:
`docs/superpowers/specs/2026-07-13-frontend-debug-logs-design.md`). It follows this
section's original suggestion , the same `info/warn/error` vocabulary with a
`child(source)` binding, and **no pino dependency** , but goes further than a
console wrapper, because the panel is a TestFlight Capacitor kiosk that no
external debugger can attach to:

- an in-memory ring (5k entries) is the live tail; IndexedDB (100k, 64MB, rotated
  on both caps) is the history that survives the KioskWatchdog's reloads; a
  two-generation native JSONL mirror keeps the most recent 128MB outside WebKit.
  The v5 store upgrade intentionally recreates the redundant IndexedDB cache
  once when moving down from the former 1M/1GiB ceiling; it does not cursor-walk
  the old cache or immediately refill it from the native mirror. Genuine later
  WebKit eviction still restores from the mirror normally
- automatic capture: patched `console.*`, `window.onerror`,
  `unhandledrejection`, failed tRPC/HTTP calls (procedure, duration, status,
  error/body shape), and React Query status transitions. Successful polling is
  deliberately silent: it previously produced millions of redundant writes
  while failures and recovery transitions carried the diagnostic value
- the native shell atomically records lifecycle state, physical/peak memory
  footprint, cumulative + interval CPU, thermal state, battery, app uptime,
  device uptime, and the newest 16 exact memory-warning/WebKit-termination/
  recovery events every five minutes and on transitions; Build 104 can decode
  the smaller Build 103 record already on disk. A first memory warning reloads
  the authenticated origin; the first repeat anywhere inside the rolling hour
  performs a staged inert-document WebKit reset before returning to the
  authenticated origin. Further warnings are suppressed until that staged
  reset ages out of the rolling hour, preventing a recovery loop. This is local
  recovery, **not** missing-heartbeat alerting
- MetricKit app-exit, peak-memory, crash, hang, CPU and termination evidence is
  retained independently across launches (newest four payloads, at most 64 KiB
  each). A bounded raw prefix remains in the native archive, while a structured
  summary is extracted from the complete payload before that bound is applied;
  `frontend_log` receives at most eight relevant values so the logger's
  2,000-character per-entry bound cannot clip the evidence unpredictably.
  MetricKit delivery is asynchronous and may arrive well after the causative
  exit; absence in the first post-restart snapshot is not evidence of absence
- read on-device via Settings , "View logs", or query the shipped Postgres rows
  by stable `device_id`

> **Update 2026-07-18 / 2026-07-26.** The frontend ships to
> **Postgres** (`frontend_log`, see "Logging And Config" in
> `CODEBASE_OVERVIEW.md`), not Loki. The 8 GiB Mac mini was retired, and a
> Loki/Grafana stack exists again on home-server
> (#33/#216, `docs/observability.md`). It collects **container** logs; frontend
> logs still go to Postgres.

**§4 (redaction) is deliberately NOT applied to the web app.** The tRPC link
records request inputs verbatim. This is an explicit decision by the panel's
owner, not an oversight: the wall panel is a private device on a home network,
the logs never leave it, and a failure whose input you cannot see is one you end
up guessing about. It does mean payloads (Tesla coordinates, camera URLs) sit in
IndexedDB on the device. §4 continues to bind the backend services without
exception.

---

## 8. Rollout ordering

1. **Foundation** (`@repo/logger`) lands first with its redaction test green ,
   nothing else can import it until it exists. (Includes the
   `**/packages/logger/src/**` `noProcessEnv: off` biome override and the
   `packages/logger`-scoped `pino-pretty` knip ignore, see §1, §3.)
2. **api** lands next: it owns ALL `@control-center/api` domain-service logging (queue,
   controls, enforcers) via `getLogger()` (§5 ownership note).
   This must precede worker/media-worker because those shared files are edited
   here ONLY.
3. Then **worker / media-worker / bosun** adopt. They are parallel **with each
   other** (each touches only files it owns, its own `runtime.ts`/`index.ts`,
   or bosun's `cli.ts`/`serve.ts`), but they are **NOT** parallel with the api
   ticket on the shared `@control-center/api` files: those are already done by step 2, so
   worker/media-worker adopt only the runtime and inherit the domain lines at
   runtime.
4. Docs updated to reflect actual implementation (no deviations from the plan above).

**These tickets are NOT fully parallel.** The api ticket is on the critical path
for all shared `@control-center/api` domain code; worker/media-worker/bosun parallelise
only among themselves after it lands. Each service ticket is independently
revertable, but the ordering above avoids parallel worktrees conflicting on
`jobs/queue.ts`.
