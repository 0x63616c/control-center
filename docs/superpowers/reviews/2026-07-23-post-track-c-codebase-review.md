# Post-Track-C Codebase Review

Date: 2026-07-23
Reviewer: solo read-only walk (senior-review pass), feeds a human-driven collaborative review session.
Scope: `features/*`, the codegen seams, the `apps/api` shell, `packages/platform/env`, cross-cutting.
Method: read-only. No source touched. Vocabulary from `docs/writing-scalable-typescript` and the
deep-module/seam/information-leakage lexicon.

The migration is in genuinely good shape. Manifests and facets are strikingly consistent, the codegen
is mostly a clean generic barrel, and the env registry is a real improvement. The findings below are
about the *unfinished last 20%* — a handful of features that folded their UI + tRPC surface but left
their worker cycle, HTTP serve routes, and connection handling behind in `apps/api`, plus a couple of
seams that are generic on the API side but still hand-wired on the web side.

---

## Status: triaged and ticketed 2026-07-25 — with two corrections

Every actionable finding below was recorded as a Ticket; each Ticket quotes its finding verbatim. Three
items were **not** ticketed because they are done or were never real:

- The **device-ownership hoist** shipped (`311ab7ce8`) — `ownerOf`/`DeviceOwner` now live in
  `packages/core/src/device-state/ownership.ts`.
- The **type-safety sweep** is a phantom task: zero `@ts-ignore` in the repo, all 21 sites are
  justified `@ts-expect-error` in tests/scaffolding, and the single production `any`
  (`features/wakes/photos.ts` `NodePgDatabase<any>`) already carries a `biome-ignore` plus rationale.
- **F3.5** was already flagged as "not a problem".

**Correction 1 — finding #5 / X.1 ("`guest-wifi` has zero tests") is FALSE.** The original pass
searched only inside `features/guest-wifi/` and concluded the auth logic was untested. It is not:
`apps/api/src/__tests__/portal-service.test.ts` is a 252-line suite covering the exact behaviours the
finding named — global daily wrong-attempt limit, that the limit is global rather than per-MAC, UTC-day
rollover, idempotent MAC authorization, server-side re-verification, and the brute-force cap — alongside
four more portal test files. The real (much smaller) issue is that guest-wifi is the last feature whose
tests never moved with the fold; that is #96.

**Correction 2 — F1.5 ("`repo.fake.ts` is imported by nothing") is FALSE.** It is imported by
`apps/api/src/__tests__/portal-service.test.ts:12`. Being unreferenced from runtime code, it does not
ship in the bundle regardless of which directory it sits in. This also undercuts F1.3's "the pattern
buys nothing" reasoning — the Repository inversion is actively paying for itself.

Lesson for future review passes: "feature X has no tests" must be checked against the whole repo, not
the feature directory, while test-location debt from a migration is still being paid down.

---

## Executive summary — top 5 for a human

1. **N independent Postgres pools per process.** Every feature's `db.ts` (and `ac`/`ctrl` `deps.ts`)
   calls `createPool(config.DATABASE_URL)` — and `createPool` is a bare `new Pool({connectionString})`
   with no `max`. The `apps/api` process imports the merged router, which imports all 16 feature
   `api.ts` → `db.ts`, so a single api pod can hold ~13 independent pools (11 feature dbs + ac/ctrl
   device-state pools + `apps/api`'s own). Lazy, so idle cost is zero, but under load each can grow to
   its own default max (10) independently → ~130+ connections. Directly at odds with the repo's own
   "design for 10x–100x" invariant. **High.**

2. **Split ownership: folded features left their worker cycle in `apps/api`.** `weather` and `sound`
   own their cycles (`features/weather/ingest.ts`, `features/sound/enforcer.ts|poller.ts`). But
   `weight`, `ac` (climate-enforcer), `ctrl` (light-enforcer + party), and `device-sync` still live in
   `apps/api/src/services/*` and reach *into* the feature (`@features/weight/schema`,
   `@features/weight/service`) while using `apps/api`'s own `db` + `ha` — a *different* pool than the
   feature's own. There is no generic interval-cycle seam (only the queue-jobs seam S1), so the worker
   hand-wires 10 cycles from two different homes. This asymmetry is the single biggest remaining
   Track-C debt. **High.**

3. **The "neutral" tRPC substrate special-cases one feature and forms a dependency cycle.**
   `apps/api/src/trpc/init.ts:1` imports `PortalError` from `@features/guest-wifi/service` to build its
   error formatter, plus `HaError` from the api integration. `app-kit/server.ts` re-exports
   `router`/`publicProcedure`/`mergeRouters` from that same `init.ts`. Result: `features → @app-kit/server
   → apps/api/trpc/init → @features/guest-wifi` (+ `apps/api`), while `apps/api` also imports
   `@features/_generated/router.gen`. A conceptual cycle centered on `init.ts`, and the generic `t`
   every feature builds on knows about guest-wifi by name. **High.**

4. **`tiles.gen.ts` is generated but has no runtime consumer; the web board hand-wires 16 manifest
   imports.** `router.gen.ts` eliminated per-feature router imports in `apps/api`, but the equivalent
   was never done for the board: `apps/web/src/lib/tile-registry.ts:2-17` statically imports all 16
   manifests by hand. `GENERATED_TILES` (the largest gen file, 5 KB) is only written and drift-checked
   — nobody reads it. Placement data is therefore dual-sourced (manifest + unused gen projection). **Med-High.**

5. **`guest-wifi` — the security-sensitive captive-portal auth flow — has zero tests, yet ships a
   purpose-built fake.** It is the *only* feature with no `*.test.*` (rate-limit, wrong-attempt
   lockout, idempotent MAC authorization — exactly the logic you want tested). `repo.fake.ts` exists
   solely for service tests that were never written; its header claims it lives "in `__tests__` so it
   never ships in the bundle" but it sits at the feature root, so it may bundle. **High (risk), Med (effort).**

---

## Focus area 1 — `features/*` consistency

**Manifest/facet conventions are excellent — call this out as a win.** All 16 manifests are byte-shaped
identically (`defineApp` default export, verbatim board coords, doc comment naming wave + home/guest
status). All 16 `api.ts` use `defineApi(router({...}))` over `@app-kit/server`, never a raw `apps/api`
import (Biome-enforced). All `config.ts` are a one-line `ENV.pick(...)` projection. The multi-tile
folds (`weather`, `tv`, `sound`, `events`) all use the `tiles: TileSpec[]` shape cleanly, and the
`app id != tile id` case (`tile_weather` vs `tile_weath`/`tile_hourly`) is handled correctly by the
collect dedup. This is the strongest part of the migration.

### F1.1 — Feature `db.ts` is copy-pasted boilerplate — extract `createFeatureDb`
`features/{booth,ctrl,deploys,events,felogs,guest-wifi,notif,wakes,weather,weight,...}/db.ts`
Every one is the same two lines: `const pool = createPool(config.DATABASE_URL); export const db =
drizzle(pool, { schema });` wrapped in a paragraph of doc comment. This is shallow duplication and it
is the surface through which finding #1 (pool multiplication) spreads.
**Direction:** add `createFeatureDb(url, schema)` to `@www/core` that memoizes the pool per-URL
(one shared pool per process) and returns the drizzle handle. Collapses ~11 files to one line each
*and* fixes the pool-count problem in one place. **Value: Med (High if merged with #1).**

### F1.2 — `deps.ts` HA-client construction duplicated across `ac`/`ctrl`/`tv` (and dogcam)
`features/ac/deps.ts:24`, `features/ctrl/deps.ts:11`, `features/tv/deps.ts:9`
Identical `createHomeAssistantClient({ baseUrl: config.HA_URL, token: config.HA_TOKEN })`. Each doc
comment even says "mirroring features/ac/deps.ts". This is fine as a pattern (env-free client bound to
a config slice — good deep-module hygiene) but it is literally the same expression 3–4×.
**Direction:** a `@www/core` `haFromConfig(config)` helper, or accept the duplication as deliberate
per-feature binding. Lower priority than F1.1 because the slices genuinely differ per feature.
**Value: Low.**

### F1.3 — `guest-wifi` uses a Repository-inversion pattern nothing else uses
`features/guest-wifi/repo.ts`, `repo.fake.ts`, `service.ts` (`PortalRepo` interface)
It's the only feature that inverts DB access behind an interface with a drizzle adapter + in-memory
fake. This is arguably the *better* pattern (deep, testable seam) and the direction the repo's
scaling ethos points to — but it's an inconsistency, and right now it buys nothing because the tests
that would consume the fake don't exist (see #5). Decide: standardize on it, or drop the unused fake.
**Value: Low (design preference) — but resolve alongside #5.**

### F1.4 — Cross-feature import `wakes → felogs` is unenforced
`features/wakes/service.ts:16` imports `frontendLog` from `@features/felogs/schema`. The Biome rule for
`features/**` bans `@control-center/api` but does **not** ban `@features/<other>`. So feature→feature
coupling is allowed and will grow silently. Documented/sanctioned here, but there's no guardrail
keeping the next one intentional.
**Direction:** either add a Biome rule flagging cross-feature imports (allowlist the sanctioned ones)
or hoist genuinely-shared tables (like `frontendLog`) into a neutral schema. **Value: Med.**

### F1.5 — `repo.fake.ts` location vs its own doc claim
`features/guest-wifi/repo.fake.ts:4` — "Kept in `__tests__` so it never ships in the bundle." It is at
the feature root, not `__tests__`. Since it's imported by nothing, Knip should be flagging it; if it
isn't, verify it's tree-shaken out of the api bundle. **Value: Low.**

---

## Focus area 2 — the codegen seams

**The core codegen is clean.** `collect.ts` is a genuinely generic scan: it iterates `featureDirs()`,
reads branded facets by symbol (`APP_BRAND`, `JOBS_FACET_BRAND`, `CRON_BRAND`, `HTTP_FACET_BRAND`),
never invokes handlers, sorts deterministically, and the `INTERIM_HTTP_MODULES` escape hatch is
correctly drained to empty. `router.gen`/`guest-router.gen`/`jobs.gen`/`http.gen`/`schema.gen` are all
generic import barrels with zero per-feature `if`. No individual-feature special-casing survives in the
collect/emit path. Good.

### F2.1 — The tiles seam is generic on the API side, hand-wired on the web side
`apps/web/src/lib/tile-registry.ts:2-17` vs `features/_generated/tiles.gen.ts`
`GENERATED_TILES` is emitted and drift-checked but imported by no runtime code (`grep` confirms only
`apps-gen.ts`/`apps-check` reference it). The board instead hand-lists all 16 `import xManifest from
"@features/x/manifest"`. The data-only gen file legitimately can't carry component refs — but that's
exactly why the *right* generated artifact for the web side is a barrel that imports each manifest and
re-exports the registry array (mirroring `router.gen`'s "import each api, merge" shape), not a data
projection. As-is, placement is dual-sourced and the drift check guards data nobody consumes.
**Direction:** either generate `tiles.web.gen.ts` (import each manifest → registry array, kill the 16
manual imports) or delete `tiles.gen.ts` if the manual list is the intended source of truth. Don't
keep an unconsumed generated file under a drift check. **Value: Med-High.**

### F2.2 — Facet types have two homes (`JobSpec` in `@www/core`, `HttpRoute`/`CronSpec` in `app-kit`)
`app-kit/define-facets.ts:1` imports `JobSpec` from `@www/core` and re-exports it, while defining
`HttpRoute`/`CronSpec` locally; `jobs.gen.ts` imports `JobSpec` from `@www/core` but `http.gen.ts`
imports `HttpRoute` from `@app-kit`. The authoring surface is split across two packages for no
principled reason a reader can see.
**Direction:** pick one home for facet contract types (app-kit is the authoring surface, so probably
there) and re-export from the other. **Value: Low.**

### F2.3 — `schema.gen.ts` uses `export *` — silent collision risk on non-table exports
`features/_generated/schema.gen.ts` re-exports `*` from every feature schema + the base schema. The
validator rejects duplicate *table names*, but two features exporting the same *symbol* name (an enum,
a zod schema, a helper) would be a TS star-export collision the table-name check can't see.
**Direction:** either restrict feature `schema.ts` to table exports only (lint), or have the emitter
namespace them. Low probability today, but this is a "design for growth" seam. **Value: Low.**

---

## Focus area 3 — `apps/api/src` shell (how close to routers-only?)

Closer than the CODEBASE_OVERVIEW suggests (that doc is stale — it still describes `src/env.ts`,
deleted, and a services-heavy architecture). But `apps/api` is **not** routers-only; it is still the
holding pen for every folded feature's *non-tRPC* residue.

### F3.1 — Worker interval cycles for `ac`/`ctrl`/`weight` still live in `apps/api/src/services`
`apps/api/src/services/{climate-enforcer,light-enforcer,party,device-sync,weight}-service.ts`
These are the counterpart to finding #2. `weight-service.ts:8-14` imports `@features/weight/schema` +
`@features/weight/service` for its domain logic but binds them to `apps/api`'s own `db` and `ha` — so
the ingest cycle and the feature's read path run over two different pools against the same table
(`felogs/db.ts` documents this "two pools, same table" pattern as accepted precedent — it's spreading).
Ownership is inverted: the feature owns its data and read path, but `apps/api` owns the write cycle.
**Direction:** hoist each cycle into its feature (`features/weight/ingest.ts`, `features/ac/enforcer.ts`,
`features/ctrl/light-enforcer.ts` + `party.ts`), reusing the feature's own `db`/`deps`, exactly as
`weather`/`sound` already do. Then introduce a generic interval-cycle facet (`defineWorkers`) so the
worker folds them like `GENERATED_JOBS` instead of hand-wiring. Entanglement: `weight` is the least
entangled (self-contained ingest) — do it first as the template. `climate`/`light`/`party` share the
`device_state` store + `command-window` from `@www/core`, so they're already substrate-backed and
should move cleanly. `device-sync` (fan-only) is the thinnest and could fold into `ac`. **Value: High.**

### F3.2 — `worker-deps.ts` is a shallow barrel that launders 7 domain cycles out of `apps/api`
`apps/api/src/worker-deps.ts`
Its own doc calls it "the documented seam … the planned packages/core extraction will move these out of
api and delete this file." It re-exports 8 functions (7 cycles + `runGithubPollCycle` from a feature)
plus `jobs/queue` + `migrate`. It exists only because F3.1 hasn't happened. Once cycles move to
features, this barrel loses its reason to exist and the worker imports each cycle from its feature.
**Direction:** resolve as the natural consequence of F3.1; don't invest in the barrel. **Value: Med.**

### F3.3 — HTTP serve routes are half-migrated: POST ingest is a facet, GET serve is still hand-wired
`apps/api/src/server.ts:113-191`
The S3 http facet moved the *ingest* routes (`POST /media/wake-photo`, `/media/booth-photo`,
tv-artwork) into `features/{wakes,booth,tv}/http.ts`. But the *byte-serving* GET routes for the same
features remain hand-wired in `server.ts` (`/media/camera-stream` → `@features/dogcam/service`,
`/media/wake-photos/*` → `@features/wakes/photos`, `/media/booth-photos/*` → `@features/booth/service`),
plus `/health/climate` → `@features/ac/service`. So `apps/api` still reaches into four feature internals
for HTTP, and a single feature's routes are split across two files. Leaky seam.
**Direction:** move the GET serve + health routes into the same feature `http.ts` facets (they already
support `match: "prefix"`). `handle()` then collapses to: route table → `/up` → `/trpc` → 404.
**Value: Med.**

### F3.4 — Boot side-effects reach into features
`apps/api/src/server.ts:64-87` — `migratePhotoPaths(db)` and `backfillWakePhotoIndex(db)` are
wakes/booth-specific boot hooks living in `apps/api`, importing `@features/wakes/photos`. Same
ownership inversion as F3.1/F3.3 in miniature.
**Direction:** a `defineBoot`-style hook facet *if* more features need boot hooks; otherwise fold these
into the feature and have the app iterate a generic boot list. Don't build the facet for two callers —
flag it, let the human decide. **Value: Low-Med.**

### F3.5 — What legitimately stays in `apps/api` (not a problem, for triage clarity)
`trpc/routers/{health,settings,device-settings,system}.ts` are genuinely cross-cutting (settings
singleton synced across panels, device settings, liveness) and correctly remain the `baseRouter`.
`device-ownership.ts`, `settings-service.ts`, `device-settings-service.ts` are shared substrate that
plausibly belongs in `@www/core` eventually but is not feature-specific residue. `integrations/
homeassistant/` is a candidate for `@www/core` (features already use the core HA client via `deps.ts`;
this second copy is what F3.1's cycles bind to). No action needed this pass beyond noting it.

---

## Focus area 4 — `packages/platform/env` registry

**Solid design — this is a real upgrade.** The lazy-Proxy + memoized-cache approach genuinely fixes the
import-order bug it was built for (parsing is deferred to first access, so hydration can't freeze a
pre-hydration default). `pick()` throwing on an unpicked key is a nice make-bad-code-hard-to-write
guardrail. The field-builder chain (`.required()`/`.optionalSecret()`/`.devDefault()`/`.forRuntime()`)
is expressive and the `optionalSecret()` "keeps static type `string`, resolves `undefined` at runtime"
decision is honest and well-documented. `assertEnv` fail-fast at boot is the right shape.

### F4.1 — `forFeature` is a single-owner tag on multi-feature keys — misleading
`packages/platform/env/manifest.ts`
`HA_URL`/`HA_TOKEN` are used by ac/ctrl/dogcam/tesla/tv (the section comment even says so) but
`HA_TOKEN` is `.forFeature("ac")`. `MEDIA_STORAGE_DIR` is `.forFeature("booth")` though wakes + worker
use it. `YOUTUBE_INGEST_ENABLED` is `.forFeature("sound")` but it gates the worker media pipeline. The
tag is documentation-only (per the doc), so this is low-severity, but as a query/grouping surface it's
already wrong and will mislead.
**Direction:** either make it `forFeatures(...ids)` (accurate multi-owner) or demote it to a free-text
comment. **Value: Low.**

### F4.2 — `forFeature("worker")` names a runtime as a feature
`manifest.ts` — the `ASC_*` keys are `.forRuntime("worker").forFeature("worker")`. There is no
`features/worker`; "worker" is a runtime. Conflates the two axes the builder deliberately separates.
**Direction:** drop `.forFeature("worker")` (leave just `.forRuntime("worker")`), or introduce a real
owning feature (ASC poll is arguably its own concern). **Value: Low.**

### F4.3 — Key-count drift vs the design spec / memory ("44-key manifest")
The manifest declares **42** keys (hydration inputs `POSTGRES_*` are intentionally not keys). The
memory/spec figure of "44" is off by two — worth reconciling so the "answers what prod needs in one
file" claim stays literally true. **Value: Low (doc accuracy).**

---

## Focus area 5 — cross-cutting

### X.1 — Missing tests on a shipped, security-sensitive feature
See #5 / F1.5. `guest-wifi` (portal auth: rate limiting, lockout, MAC authorization) has zero tests
despite a ready-made fake. **Value: High.**

### X.2 — The generic tRPC layer is not generic (special-cases guest-wifi)
See #3. `trpc/init.ts:1` hardcodes `PortalError` into the error formatter and `HaError` into the
middleware, and `app-kit/server.ts` re-exports it as the substrate every feature builds on.
**Direction:** make error mapping an extension point — features register `(error) => data?` mappers
that init composes — so `init.ts` (and app-kit) stop importing any feature, breaking the
`features → app-kit → apps/api → features` cycle. Move the tRPC primitives to a neutral package so
`app-kit` doesn't depend on `apps/api` at all. This is the highest-leverage structural cleanup.
**Value: High.**

### X.3 — `CODEBASE_OVERVIEW.md` is stale
References the deleted `apps/api/src/env.ts` (line ~172), describes a services-centric architecture
pre-dating the features fold, and predates the env registry. A reader onboarding today would be
misdirected. **Direction:** refresh alongside the next structural change. **Value: Low-Med.**

### X.4 — Deep-module note: `createPool` is a shallow wrapper that leaks pool policy
`packages/core/src/db/pool.ts:7` — `new Pool({ connectionString })` with no `max`, no app-level
policy, called from 13 sites. It's the thinnest possible wrapper and it leaks the "how many pools /
how big" decision to every caller (which all make the same un-decision). A deeper module would own
pool lifecycle for the whole process (memoize per URL, set `max`, expose one handle). Ties #1 + F1.1
together as one fix. **Value: High (as the mechanism behind #1).**

---

## Triage split for tomorrow

### Safe autonomous follow-ups (mechanical, low-judgment, individually shippable)
- **F1.1 + X.4:** add `createFeatureDb`/memoized `createPool` to `@www/core`, migrate the ~11 `db.ts`
  + `ac`/`ctrl` `deps.ts` to it. Set a sane `max`.
- **F2.3 / F2.2:** unify facet-type home; add a lint restricting `schema.ts` to table exports.
- **F4.1 / F4.2 / F4.3:** fix `forFeature` tags, drop `forFeature("worker")`, reconcile the 42-vs-44
  count in the spec/memory.
- **F1.5:** confirm `repo.fake.ts` is tree-shaken (or move to `__tests__`).
- **X.3:** refresh `CODEBASE_OVERVIEW.md` (env registry + features fold + delete `env.ts` reference).
- **X.1 / #5:** write the guest-wifi service tests against the existing fake (pure logic, no infra).

### Needs human judgment (architecture / ownership decisions)
- **#2 / F3.1 / F3.2:** hoist interval cycles into features + design the generic interval-cycle facet
  (`defineWorkers`). This is the big one — decide the seam shape, then it can be executed feature by
  feature (`weight` first as template). Deletes `worker-deps.ts`.
- **#3 / X.2:** de-feature-ify `trpc/init.ts` (error-mapper extension point) and relocate the tRPC
  primitives so `app-kit` stops depending on `apps/api`. Breaks the dependency cycle; touches the
  authoring contract, so needs sign-off.
- **F2.1:** decide the tiles source-of-truth (generate a web barrel vs. delete `tiles.gen.ts`).
- **F3.3 / F3.4:** decide whether GET-serve routes + boot hooks become feature facets (and whether a
  `defineBoot` facet is worth building for two callers).
- **F1.3 / F1.4:** decide whether to standardize on the guest-wifi Repository pattern and whether to
  enforce/allowlist cross-feature imports in Biome.
