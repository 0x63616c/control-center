# Plan review — Fold felogs into `features/felogs`

Reviewer: independent PLAN-REVIEWER (did not write the plan). Verified against real
code at HEAD, read-only.

## Verdict: **APPROVE-WITH-FIXES**

The plan is accurate and thorough. Coords, guest-exposure, the web transitive
closure, the cross-feature reader repoint, the worker/enforcer "nothing to wire"
claim, and every base deletion were checked against the real tree and hold. No
BLOCKER. Three MINOR fixes below — the only one that can actually turn a verify step
red is #1 (an internal contradiction between the `api.ts` snippet and the test-rework
instruction). All are trivially fixed inside the same atomic commit.

Counts: **0 BLOCKER / 0 MAJOR / 3 MINOR.**

---

## What I verified as CORRECT (evidence)

- **Coords verbatim.** `tile-registry.ts` `tile_felogs` block: `worldCol 26,
  worldRow 30, cols 4, rows 2`, label `"Frontend Logs"`. Manifest snippet matches
  byte-for-byte. No overlap risk (same rect, same coords → board byte-identical).
- **guestExposed handled.** `features/guest-exposed.ts` `GUEST_EXPOSED = ["tile_guestwifi"]`.
  Plan sets no flag and does not touch the allowlist → validator flag⇔allowlist
  cross-check stays consistent (both-absent).
- **Web closure fully enumerated.** `grep -rln FrontendLogs` over `apps`/`features`
  (excluding build/coverage/node_modules) returns exactly: `FrontendLogsTile.tsx`,
  `FrontendLogsTileView.tsx`, `FrontendLogsTileView.stories.tsx`,
  `detail/wiring/frontend-logs.tsx` (the 4 to move) + `tile-registry.ts` +
  `detail/registry.ts` (the 2 import sites the plan repoints) +
  `detail/__tests__/registry-entries.test.ts` (unaffected — `tile_felogs` keeps a
  registered entry). No `*.test.tsx`/`*.stories.test.tsx` for this tile. Matches the
  plan's "4 files, no web test" claim exactly.
- **Import repoints real.** `FrontendLogsTile.tsx` imports `../../lib/log/logger`,
  `../../lib/log/store`, `./FrontendLogsTileView`, `@/components/ui`.
  `FrontendLogsTileView.tsx` imports `../../lib/log/types`, `@/components/ui`. Story
  imports `./__stories__/factory`, `./FrontendLogsTileView`. Detail wiring imports
  `@/lib/settings-overlay-store`, `../types`. Every repoint rule in the plan lands on
  a real import.
- **Storybook glob already covers `features/**`.** `apps/web/.storybook/main.ts:15`
  = `"../../../features/**/*.stories.@(ts|tsx)"`. Covers `features/felogs/web.stories.tsx`.
  Not re-needed (weather landed it). Correct.
- **Title guard.** `FrontendLogsTileView.tsx:73,94` render `title="Frontend Logs"` →
  matches manifest label. tile-title-sync stays green.
- **Cross-feature reader.** `interaction-session-service.ts:18-19`:
  `import type * as schema from "../db/schema"` (stays) and
  `import { frontendLog, wakePhoto } from "../db/schema"`. The split repoint
  (`wakePhoto` stays, `frontendLog` → `@features/felogs/schema`) is exactly right;
  `apps/api → @features` is the biome-legal direction; `wakePhoto` correctly left
  behind for the wakes fold. `interaction-session-service.test.ts` exists and imports
  service functions, not the table — unaffected. **felogs EXPORTS the table via its
  own `schema.ts`; it does NOT move the session service.** Goal met.
- **Boundary-safe.** No surviving `features/felogs → apps/api` import in any moved
  backend file (all repoint to `@app-kit`/`@app-kit/server`, `@www/core`,
  `@www/logger`, or `./`). The one new `apps/api → @features` import is the sanctioned
  session-service line. (One caveat on the test — see MINOR #1/#2.)
- **Worker/enforcer correctly left hand-wired (i.e. nothing).** No felogs reference
  exists in `apps/worker`; ingest is a tRPC mutation, retention is a cron. `jobs.ts`
  is `defineCron`-only, mirroring `features/weather/jobs.ts` (confirmed: weather
  exports ONLY `purgeCron`, no `defineJobs`). No invented `jobs.ts` queue facet. Correct.
- **collect.ts dedup — weather's BLOCKER does NOT recur.** `collect.ts:341`
  `featureTileIds = new Set(featureApps.flatMap((a) => a.tiles.map((t) => t.id)))`
  keys on TILE id (already fixed on main by weather). felogs is single-tile with app
  id == tile id == `tile_felogs`, so the registry-leftover filter (`:342`) drops it
  cleanly. No `collect.ts` change needed — plan is right.
- **Base deletions all present & correct.** `routers/index.ts` has the
  `import { logsRouter } from "./logs"` and the `logs: logsRouter` mount (both to
  delete). `logs.ts` uses `ctx.db` (feature swaps to `./db` — behaviour identical).
  `frontend-log-service.ts` / `frontend-log-purge-service.ts` export exactly the
  symbols the plan moves. `purge.ts` contains the import + the
  `const frontendLogs = await purgeFrontendLogs(db)` + the `frontendLogs:` log field
  + the `if (frontendLogs.truncated)` warn block — all four deletions real (see
  MINOR #3 on line numbers). `schema.ts` `frontendLog` pgTable + its comment block are
  where the plan says, `wakePhoto` immediately after (left in place).
- **schema.ts imports available.** `frontendLog` needs `sql`, `pgTable`, `text`,
  `timestamp`, `jsonb`, `primaryKey`, `index` — all importable from
  `drizzle-orm`/`drizzle-orm/pg-core` as the plan states.
- **Tests wired.** Both `__tests__` files exist with the imports the plan repoints;
  `placeholder-tiles.test.ts` at `apps/web/src/lib/__tests__/` (plan's verify glob
  matches); `registry-entries.test.ts` present.

---

## Findings

### [MINOR] 1 — `api.ts` snippet declares `const logsRouter` (unexported), but the test-rework instruction imports `logsRouter` from `./api`
The §api.ts snippet writes `const logsRouter = router({...})` and exports only
`api`. The §Tests instruction says rework the wiring assertion to "build a local
`router({ logs: logsRouter })` from `./api`" — the exact `features/weight/api.test.ts:21`
pattern, which works ONLY because `weight/api.ts` does `export const weightRouter`.
If the implementer copies the felogs snippet verbatim and then follows the weight
pattern, the test's `import { logsRouter } from "./api"` fails to resolve → typecheck
red.
**Fix:** either `export const logsRouter` in `features/felogs/api.ts` (mirror weight),
or explicitly choose the plan's stated alternative — assert against
`@features/_generated/router.gen`'s `featureAppRouter` (no `logsRouter` export
needed). Pick ONE in the plan so the implementer isn't left with a contradictory
snippet+instruction.

### [MINOR] 2 — make explicit that the moved `service.test.ts` must DROP its `appRouter` import, or it becomes a banned `features/* → apps/api` import
The current `frontend-log-service.test.ts` imports `appRouter` from
`../trpc/routers/index` (line 18) and both trailing describes
(`"logs router wiring"` :179 and `"layout router removal"` :185) assert against
`appRouter._def.procedures`. Once this file lands at `features/felogs/service.test.ts`,
ANY surviving import of `apps/api`'s `appRouter` is a Biome `noRestrictedImports`
violation (`features/* → apps/api`) → `bun run lint` red, not just a test smell. The
plan does address both blocks (rework the wiring one; PLACEHOLDER-FELOGS-1 drops the
layout one) but frames it as a test-quality choice; call out that removing the
`appRouter` import is a **hard boundary requirement**, not optional.
**Resolution of PLACEHOLDER-FELOGS-1:** DROP `describe("layout router removal")`. It is
a stale guard for a router removed long ago, is not felogs-specific, and could only be
kept by importing `apps/api`'s `appRouter` — forbidden inside a feature. Do not drag
it into the feature; do not relocate it as part of this unit.

### [MINOR] 3 — `purge.ts` deletion line numbers are stale; delete by content
The plan cites `purge.ts` lines 26/33/38/45-47. The real file's imports and body sit
a few lines off (the module has a long header comment). All four targets exist and are
correctly identified by content (the `purgeFrontendLogs` import, the
`const frontendLogs = await purgeFrontendLogs(db)` call, the `frontendLogs:` log
field, the `if (frontendLogs.truncated)` warn block). Implementer should match by
content, not line number. Non-blocking.

---

## Notes (no action)
- `wakePhoto` staying imported from `apps/api/src/db/schema` in the session service is
  correct for this unit; it repoints with the wakes fold.
- Do NOT run `db:generate` — the table SET is unchanged (same name/columns/indexes),
  no migration. Plan already says this.
- ONE atomic commit is correctly mandated (dup-router-key `logs` / dup-table
  `frontend_log` throw otherwise). Honor it.

Once the two one-line clarifications are folded into the plan, this is
ready to implement.
