# App Construct Implementation Plan

> **Historical note (2026-07-27):** "Temporal is OUT" below was true when this plan
> executed — it introduced no workflow engine. Temporal has since been self-hosted
> (`infra/src/temporal.ts`, `apps/temporal-worker/`) and now owns scheduled app work via a
> `workflows.ts` facet built on this plan's codegen — see ADR-0008.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Slices use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the 19 scattered Tiles + their routers, Worker Cycles, Queue Jobs, Chrome, and tables into self-contained **Apps** — one folder per App under `products/control-center/apps/<id>/` — wired by a committed **codegen** step, migrating one deployable green push at a time with zero behaviour change per slice.

**Architecture:** The filesystem is the **interface** (a folder existing *is* the App's registration); `bun run apps:gen` is the **compiler** that globs the folders and emits committed `_generated/*.gen.ts` aggregates byte-compatible with today's hand-written `TILE_REGISTRY`, `appRouter` literal, and `Worker[]` array; the runtime stays 100% static so `AppRouter = typeof appRouter` flows through `packages/api` to the web client unchanged. The App interface (`app-kit/`) and the App folders (`apps/`) are **plain source directories** inside the control-center product — not new workspaces — so `biome.json`, `vitest.config.ts`, `knip.jsonc`, and the product-boundary guard are undisturbed.

> **Build-context caveat (do NOT skip — this is the #1 way Slice 0 goes red):** the service images bundle each shell's `src` graph with `bun build`, and every service Dockerfile today `COPY`s only its own service dir plus `packages/`. The moment the three shells re-export runtime values (`TILE_REGISTRY`, `appRouter`, `Worker[]`, `schema`) from `products/control-center/apps/_generated/*` and `app-kit/*`, those files MUST be in each bundling image's build context or `bun build` fails "Could not resolve." **Slice 0 therefore edits the Dockerfiles too** (see Slice 0 Files). Also: because `products/control-center/*` and `products/*/apps/*` are workspace globs, `apps/` and `app-kit/` (and every `apps/<id>/` and `apps/_generated`, `apps/_legacy`) must **never** contain a `package.json` — bun only registers a workspace for a glob-matched dir that has one, so keeping them manifest-free is what leaves `bun.lock` workspaces (and the `check-dockerfile-manifests` guard that derives from it) untouched. `apps:check` should assert no `package.json` exists under `apps/` or `app-kit/`.

**Tech Stack:** Bun, TypeScript, tRPC v11, Drizzle, React, Vite, Storybook, Vitest, Biome, lefthook, GitHub Actions CI (`push` to `main` deploys prod).

**Source design:** `/private/tmp/.../designs/FINAL-app-construct.md` (the FINAL App-construct design). This plan is the executable form of that design. Vocabulary follows `CONTEXT.md` (Panel, Board, Chrome, Banner, Tile, Tile View, Overlay, Modal, Variant, Page, Product, App, App Manifest, Sensitive, Unlock/PIN Session, Worker Cycle, Enforcer, Queue Job, Cron, AV Control) and `codebase-design` (module, interface, implementation, depth, seam, adapter, leverage, locality, deletion test) exactly.

## Global Constraints

- **Continuous delivery.** Every slice is exactly one commit-and-push to `main`; a push deploys prod. No PRs. No batching. Each slice must leave CI green.
- **Verify before every push (cheap gates):** `bun run typecheck` and the relevant Vitest suite (`bun run test`), plus `bun run lint` where files moved. Fix forward — never sit on unpushed work.
- **No fake or placeholder data** (repo invariant; `scripts/check-fake-data.sh` runs in CI).
- **Storybook-first for new UI.** Panel is a fixed `1366x1024`, non-responsive surface.
- **Tile placement source of truth** stays the App Manifest's default rectangle; `board_tile_placement` DB rows override at runtime via the existing `resolveLayout`.
- **IDs use the `prefix_<id>` convention.** App ids are `app_<name>`; Tile ids keep their existing `tile_*` values verbatim (renaming a tile id would orphan its `board_tile_placement` override rows).
- **Backend code uses structured logging** (`@www/logger`).
- **media-worker folds into worker (USER-LOCKED).** There is one worker deployable. Infra comments about a Phase-4 media-worker bring-up are superseded. The design's `runtime: "worker" | "media-worker"` tag is reduced in this plan to an optional documentation label defaulting to `"worker"`; codegen emits a single `Worker[]` array consumed only by `products/control-center/worker`. See Open Question 1.
- **Temporal is OUT.** No workflow engine is introduced.
- **Server-side PIN is explicitly deferred** to a final, separately-sequenced slice (Slice S). Until it ships, `manifest.sensitive` means *client gate only, parity with today* — no slice may ship a `sensitive` flag that looks server-enforced while a direct tRPC call still returns the data.

---

## Reference Facts (verified against the repo at plan time)

- `products/control-center/web/src/lib/tile-registry.ts` — `TILE_REGISTRY` is a flat array of **19** `TileRegistryEntry` objects; adding a tile today means importing 2 components, extending two hand-maintained union types (`TileComponent`/`TileViewComponent`, lines 39–79), and pushing an entry. **10** entries carry `ownsTap: true` (ctrl, sched, tv, sound, tvapps, quickplay, wakes, deploys, notif, felogs); 9 use the generic showcase modal. Exactly one entry sets `home: true` (`tile_clock`).
- `products/control-center/api/src/trpc/routers/index.ts` — `appRouter = router({ … })` explicit literal, **19** keys (health, weather, network, notifications, tesla, climate, controls, camera, events, github, layout, logs, media, portal, schedules, settings, system, sessions, wakePhotos), `export type AppRouter = typeof appRouter`. The AV/Media split (Slices 11–12) turns the single `media` key into `av` + `mediaSources`, so the final key count is **20**.
- `products/control-center/worker/src/index.ts` — imports every cycle from the `@control-center/api/worker` barrel (`worker-deps.ts`) and builds a `Worker[]` array for interval cycles and feature-owned queue jobs.
- `products/control-center/api/src/worker-deps.ts` and `products/control-center/api/src/media.ts` — both self-described as **interim** barrels pending the `packages/core` extraction.
- `products/control-center/web/src/components/Board.tsx` (~1043 lines) — renders 5 hard-coded Banners in order: `DeviceNameBanner`, `ConnectionLostBanner`, `AppUpdateBanner`, `UnplacedTilesBanner`, `NotChargingBanner` (lines ~993–997).
- `products/control-center/api/src/db/schema.ts` — single Drizzle schema barrel; `drizzle.config.ts` targets it.
- No `products/control-center/apps/` directory and no `packages/core` exist yet. `packages/` holds `api`, `logger`, `platform`, `worker-runtime`.
- Drift-guard precedent: repo runs `bun scripts/check-*.ts` committed-file checks wired as CI steps (e.g. `test:product-workspaces`, `test:dockerfile-manifests`). `apps:check` follows this exact pattern.

## File Structure (locked before slicing)

```
products/control-center/
  app-kit/                         # NEW plain source dir (not a workspace). Browser-safe spine.
    manifest.ts                    # AppId, TilePlacement, TileViewSpec, TileSpec, ChromeSlot, AppManifest, defineApp
    facets.ts                      # WebFacet, ApiFacet, CycleSpec, HandlerSpec, WorkerFacet (server/browser split by import site)
    testing.ts                     # fakeApp() helper for shell tests
  apps/
    _generated/                    # COMMITTED, regenerated by `bun run apps:gen`; never hand-edited
      tiles.gen.ts                 # web    — TILE_REGISTRY + component unions (replaces tile-registry.ts body)
      chrome.gen.ts                # web    — Banners sorted by (zone, order)
      router.gen.ts                # api    — appRouter explicit keyed literal → export type AppRouter
      workers.gen.ts               # worker — Worker[] + handler registrations
      schema.gen.ts                # api/db — re-exports every apps/*/schema.ts
      manifests.gen.ts             # iso    — AppManifest[] (sensitive flags, ids, placement) for the shell
    _legacy/                       # Slice 0 shim; re-exports today's registry/routers/workers; deleted in final slice
      manifest.ts
      web.tsx
      api.ts
      jobs.ts
      schema.ts
    <app_id>/                      # one folder per App, added incrementally
      manifest.ts  web.tsx  api.ts  jobs.ts  schema.ts   (only the facets it needs)
  scripts/
    apps-gen.ts                    # the codegen (glob → emit); exposed as `bun run apps:gen`
    apps-check.ts                  # CI guard: run gen into a temp, assert `git diff` on _generated/ is empty
  web/src/plugins/apps-gen-vite.ts # dev: regenerate on manifest/facet change
packages/core/                     # NEW workspace, created at Slice 13 (device-state store first tenant)
  device-state/
```

Each App folder is one clear responsibility (one feature). Files that change together live together. `_generated/` is machine-owned; `app-kit/` is the hand-owned interface.

---

## Slice 0 — app-kit spine + codegen + `_legacy` shim (no behaviour change)

**Goal:** Stand up the whole seam end-to-end with zero files moved: `app-kit/` interface, `apps-gen.ts` codegen, the `apps:check` CI guard, the dev watch story, and a single `apps/_legacy/` App that re-exports today's `TILE_REGISTRY`, sub-routers, and worker array. The three shells switch to importing `_generated/*`. Prod behaviour byte-identical.

**Files:**
- Create: `products/control-center/app-kit/manifest.ts`, `app-kit/facets.ts`, `app-kit/testing.ts`
- Modify: `biome.json` — add the `noRestrictedImports` App-boundary rule (error level) described in codegen act 3
- Create: `products/control-center/apps/_legacy/{manifest,web,api,jobs,schema}.ts`
- Create (emitted, then committed): `products/control-center/apps/_generated/{tiles,chrome,router,workers,schema,manifests}.gen.ts`
- Create: `products/control-center/scripts/apps-gen.ts`, `scripts/apps-check.ts`, `web/src/plugins/apps-gen-vite.ts`
- Modify: `products/control-center/web/src/lib/tile-registry.ts` — re-export `TILE_REGISTRY`, `HOME_TILE`, `registryEntryForComponent` from `../../../apps/_generated/tiles.gen` (three levels up: `lib`→`src`→`web`→`control-center`; keep the file as a stable import site so no Board/Storybook caller changes)
- **Modify the Dockerfiles (REQUIRED — without this Slice 0's image builds go red):** add `COPY products/control-center/apps products/control-center/apps` and `COPY products/control-center/app-kit products/control-center/app-kit` (right after the existing service-source `COPY`, before the `bun build` line) to every image that bundles a shell whose graph now reaches the generated aggregates:
  - `products/control-center/api/Dockerfile` (bundles `api/src/server.ts` → `routers/index.ts` → `_generated/router.gen` → `_legacy/api` + `app-kit`)
  - `products/control-center/worker/Dockerfile` (bundles `worker/src/index.ts` → `_generated/workers.gen`)
  - `products/control-center/web/Dockerfile` (bundles `web` → `tile-registry.ts` → `_generated/tiles.gen`)
  - `products/control-center/web/Dockerfile.storybook` (same web graph as above)
  - `products/control-center/media-worker/Dockerfile` — add the same two COPYs defensively (it bundles `api` and is only guaranteed clear once its `bun build` graph provably never reaches `routers/index.ts`; cheap insurance until the media-worker retirement slice deletes this image entirely).
  These are build-context copies only; `check-dockerfile-manifests.ts` inspects `COPY <dir>/package.json` lines exclusively, so adding whole-dir COPYs does not affect that guard.
- Modify: `products/control-center/api/src/trpc/routers/index.ts` — becomes a one-line re-export of `apps/_generated/router.gen`
- Modify: `products/control-center/worker/src/index.ts` — build `workers` from `apps/_generated/workers.gen` (`"worker"` slice)
- Modify: `products/control-center/api/drizzle.config.ts` — point `schema` at `apps/_generated/schema.gen.ts` (which for now re-exports `api/src/db/schema.ts`)
- Modify: root `package.json` scripts — add `"apps:gen": "bun products/control-center/scripts/apps-gen.ts"` and `"test:apps-check": "bun products/control-center/scripts/apps-check.ts"`
- Modify: `.github/workflows/ci.yml` — add `bun run test:apps-check` to the test-gate step alongside the other `check-*` scripts
- Modify: `products/control-center/web/vite.config.ts` — register the `apps-gen-vite` plugin (regenerate on `apps/**/manifest.ts` or facet change during `bun run dev`)
- Test: `apps/_generated/consistency.test.ts` (skeleton; grows across slices)

**Interfaces produced (every later slice consumes these — exact shapes):**

```ts
// app-kit/manifest.ts
export type AppId = `app_${string}`;
export interface TilePlacement { worldCol: number; worldRow: number; cols: number; rows: number; }
export type TileViewSpec =
  | { kind: "page" }
  | { kind: "modal" }
  | { kind: "self" }
  | { kind: "pageRef"; pageId: string };
export interface TileSpec {
  id: string;                 // keep existing tile_* id verbatim
  label: string;              // MUST match the title the tile renders in its TileHeader
  placement?: TilePlacement;  // DEFAULT only; omit ⇒ unplaced (UnplacedTilesBanner)
  view: TileViewSpec;
  home?: true;                // EXACTLY ONE across all Apps (the Clock)
}
export interface ChromeSlot { id: string; zone: "top" | "bottom"; order: number; }
export interface AppManifest {
  id: AppId;
  title: string;
  tiles?: readonly TileSpec[];
  chrome?: readonly ChromeSlot[];
  sensitive?: true;           // CLIENT GATE ONLY until Slice S; see Global Constraints
  routerKeys?: readonly string[];
  workers?: readonly string[];
  tables?: readonly string[];
}
export function defineApp<const M extends AppManifest>(m: M): M { return m; }

// app-kit/facets.ts
import type { ComponentType } from "react";
import type { AnyTRPCRouter } from "@trpc/server";
export interface WebFacet {
  tiles?: Record<string, { card: ComponentType; view?: ComponentType }>;
  chrome?: Record<string, ComponentType>;
}
export interface ApiFacet { routers: Record<string, AnyTRPCRouter>; }
export interface CycleSpec {
  name: string; intervalMs: number; runOnStart?: boolean;
  run: () => Promise<void> | void;
  runtime?: "worker" | "media-worker";   // optional doc label; defaults to "worker" (media-worker folded in)
}
export interface HandlerSpec { jobType: string; register: () => void; runtime?: "worker" | "media-worker"; }
export interface WorkerFacet { cycles?: readonly CycleSpec[]; handlers?: readonly HandlerSpec[]; }
```

**What codegen (`apps-gen.ts`) does — the five acts:**
1. Glob `apps/*/manifest.ts` (excluding `_generated`); import each → `AppManifest[]`.
2. Statically detect which convention facet files exist per folder (`web.tsx`/`api.ts`/`jobs.ts`/`schema.ts`) and emit **explicit static imports** into the generated files — never a runtime `import.meta.glob` for anything the type system must see.
3. **Import-boundary check:** the primary enforcement is a **Biome `noRestrictedImports` rule at error level** forbidding `web.tsx`/chrome from importing `api.ts`/`jobs.ts`/`schema.ts` within an App folder. This is already a HARD CI gate — `bun run lint` runs in CI expressly to catch `--no-verify` bypasses — so it blocks deploy on its own; a second hand-rolled import-graph parser would be redundant standing machinery for a check the linter already fails CI on. `apps-gen.ts` adds only a **cheap belt-and-suspenders assertion at gen time**: while it already reads each folder's facet files to emit the static imports, it fails the run if a `web.tsx` source string statically imports a sibling `api.ts`/`jobs.ts`/`schema.ts` (a substring/relative-specifier check on the imports it is already parsing — not a separate AST module). No standalone `import-boundary.ts` parser + test is built.
4. **Placement guard (softened to match the domain):** assert exactly one `home` Tile, no two Tiles share the *exact* default origin `(worldCol, worldRow)`, and no default is off-world. Do **not** forbid arbitrary rectangle overlap — `tile-registry.ts` deliberately allows tiles to sit anywhere and the bento reflows.
5. Emit the six committed `_generated/*.gen.ts` files, then **run `bunx biome format --write` on `_generated/`** as the last act of `apps:gen` so the emitted TS is Biome-clean before it is committed. This is mandatory: `bun run lint` is a HARD CI gate (it exists specifically to catch `--no-verify` bypasses), and the repo's own `drizzle-meta` papercut (generated files that fail lint until hand-formatted) is the precedent to *avoid*, not repeat. Because the formatter is deterministic, the format step must live *inside* `apps:gen` so `apps-check.ts`'s temp-dir re-gen produces byte-identical output. Pin the emitter to a stable style (sorted keys, fixed quote/semicolon) so a Biome or Bun version bump does not silently churn the committed files — if it does, the diff surfaces in `apps:check` on the next push and is fixed by re-running `apps:gen`, not hand-edited. `apps-check.ts` re-runs gen (format included) into a temp dir and fails if `git diff` on `_generated/` is non-empty (drizzle-meta-gate pattern).

`router.gen.ts` is emitted as an ordinary static literal (this is the whole reason end-to-end types survive):

```ts
// apps/_generated/router.gen.ts  (emitted; looks hand-written)
import { router } from "../../api/src/trpc/init";
import { legacyApi } from "../_legacy/api";
export const appRouter = router({
  health: legacyApi.routers.health,
  weather: legacyApi.routers.weather,
  /* …one line per routerKey, path-stable… */
});
export type AppRouter = typeof appRouter;   // identical type packages/api re-exports today
```

**`_legacy` shim (the lowest-risk seam introduction):** `apps/_legacy/api.ts` re-exports every existing sub-router keyed by its current root key; `web.tsx` re-exports the existing tile components keyed by tile id with today's `worldCol/... /ownsTap` folded into `manifest.ts` `TileSpec`s (`ownsTap` → `view.kind:"self"`, generic-modal tiles → `view.kind:"modal"`); `jobs.ts` re-exports the existing cycles/handlers; `schema.ts` re-exports `db/schema.ts`. Codegen produces the same aggregates it will later produce from real App folders — proving the plumbing without asking codegen to reconstruct today's output from scratch.

**Dev watch story:** In `bun run dev`, the Vite plugin (`apps-gen-vite.ts`) watches `apps/**/manifest.ts` and facet files and re-runs gen on change (web HMR picks up the new `_generated/*`). For api/worker dev, `bun --watch` on their entrypoints re-imports the regenerated committed files; document that a manifest/facet edit requires a saved `_generated/` (the plugin writes it) — the running api/worker process picks it up on the next `--watch` restart. `apps:gen` is also runnable standalone before committing.

**Steps:**
- [ ] Write `app-kit/manifest.ts` + `facets.ts` (pure, no React/tRPC/drizzle runtime imports in `manifest.ts`).
- [ ] Add the Biome `noRestrictedImports` App-boundary rule to `biome.json`; add a fixture App folder proving `bun run lint` fails when `web.tsx` imports `api.ts` and passes when it does not.
- [ ] Write `apps-gen.ts` performing the five acts (including the gen-time boundary assertion and the trailing `biome format --write` on `_generated/`); write `_legacy/` folder mapping today's registry/routers/workers/schema.
- [ ] Run `bun run apps:gen`; commit the emitted `_generated/*`.
- [ ] Rewire the three shells + `drizzle.config.ts` + `tile-registry.ts` to the generated aggregates.
- [ ] Write `apps-check.ts`; add `test:apps-check` to CI test gate.
- [ ] Write `consistency.test.ts` skeleton: `keys(appRouter)` equals the union of every `manifest.routerKeys`; exactly one `home`; no duplicate default origins.
- [ ] Register the Vite plugin.

**Verification:**
- `bun run typecheck` — `AppRouter` type unchanged (assert the web client still type-checks its `trpc.*` calls).
- `bun run test` — new consistency test green; `bun run lint` fails on the boundary-violation fixture and passes on the clean one.
- `bun run test:apps-check` — clean tree after a fresh `apps:gen`.
- Visual on Panel: `bun run dev`, confirm all 19 tiles render and open exactly as before; the 5 Banners still render; a router call round-trips.
- `bun run lint` + `bun run knip` (no new dead code; `_generated/*` is imported; `_generated/*` is Biome-clean straight from `apps:gen`).
- **Docker build smoke (the fatal-class check):** locally `docker build` the api, worker, web, and storybook images (or push and watch CI's build-* jobs) — the `bun build` step must resolve `_generated/*` and `app-kit/*` through the new Dockerfile COPYs. A green typecheck does NOT prove the image builds; the build context is a separate resolution surface.

**Rollback:** Revert the shell rewire commits (the three shells import from their original files again); the `apps/` and `app-kit/` dirs become inert. Because Slice 0 moves no feature code, revert is a clean `git revert` of the slice commit with no data implications.

---

## Slice 1 — consolidate the client PIN Session (no server change)

**Goal:** Replace the two duplicated `PinGateModal` instances with one shell `<PinGate>` + a global `pin-session-store`, driven by a `sensitive` lookup. Client parity with today, duplication gone.

**Files:**
- Find current gates: `grep -rl PinGateModal products/control-center/web/src` (design cites `SettingsButton.tsx` and `WakesTile.tsx`) — verify exact paths first.
- Create: `web/src/lib/pin-session-store.ts` — a `useSyncExternalStore` module store: `unlock()`, `lock()`, `isUnlocked()`, idle-timeout re-lock, re-lock on return-to-Home; `resetPinSessionForTest()`.
- Create: `web/src/components/PinGate.tsx` — the single Overlay gate wrapping `PinPadView` (keep `PinPadView` as the keypad primitive).
- Create: `web/src/components/PinGate.stories.tsx` (Storybook-first).
- Modify: the shell's Tile-View open path (in `Board.tsx`) to interpose `<PinGate>` when the opening Tile belongs to a `sensitive` App.
- Modify/Delete: remove both `PinGateModal` mount sites; delete `PinGateModal` if no longer referenced.
- Sensitive source: a temporary hardcoded `{ tile_wakes, /* settings gear */ }` set until Activity/Settings carry the flag (retired in Slices 9 and 18).

**Steps:** Storybook story for `PinGate` (locked → keypad → success unlocks) → store test (idle timeout re-locks; return-to-Home re-locks; one unlock covers a second sensitive surface within timeout) → wire Board → delete the two old gates.

**Verification:** `bun run typecheck`; `bun run test` (store + PinGate tests); Storybook renders the gate; Panel: tapping the Activity tile prompts PIN, a correct PIN opens it, opening a second sensitive surface within the timeout does not re-prompt, returning to Home re-locks. **No server change** — direct tRPC still returns data (documented, parity with today).

**Rollback:** Revert; the two `PinGateModal` instances return. No schema/data touched.

---

## Slices 2–6 — leaf Apps, no shared substrate (one push each, easiest first)

Each leaf slice creates `apps/<app_id>/{manifest.ts, web.tsx[, api.ts, schema.ts]}`, moves the tile's component + view file(s) into the folder (or re-exports them from their current location if moving risks churn — prefer moving, since locality is the whole point), removes the corresponding `_legacy` entries for that tile/router, runs `bun run apps:gen`, and commits. The shells never change — only the *source* of the generated aggregate moves.

**Per-slice shape (applies to every App slice below):**
- **Files:** `apps/<id>/manifest.ts` (+ facets it needs); move the tile component/view under the folder; delete the matching `_legacy` re-export lines and any now-empty union entry.
- **Steps:** write `manifest.ts` (copy the exact `worldCol/worldRow/cols/rows/label/id` from `tile-registry.ts`; map `ownsTap:true`→`view.kind:"self"`, generic-modal→`view.kind:"modal"`, migrated Page→`view.kind:"page"`) → move facet files → `bun run apps:gen` → typecheck + consistency test → commit.
- **Verification:** `bun run typecheck`; `bun run test` (consistency test proves `_generated` matches folders, no dangling union member, router keys still cover `appRouter`); `bun run test:apps-check` (committed `_generated` matches a fresh gen); Panel: the migrated tile renders in the same place and opens the same Tile View; unaffected tiles unchanged.
- **Rollback:** revert the slice commit — `_legacy` re-exports that tile again on the next `apps:gen` (keep `_legacy` alive until the final slice precisely so any single App slice is independently reversible).

- [ ] **Slice 2 — `app_clock`** (`tile_clock`, `home`) — tiles-only, no api/worker/table. Proves `home` + a tiles-only App. `view.kind:"modal"` (clock has no `ownsTap` today → generic showcase). Move `ClockGreeting`/`ClockGreetingView`.
- [ ] **Slice 3 — `app_frontend-logs`** (`tile_felogs`) — `logs` router (`routerKeys:["logs"]`), `frontendLog` table (`schema.ts` owns it), tile `view: { kind:"pageRef", pageId:"page_settings_logs" }`. **`pageRef` target-resolution during the interim:** Settings does not become an App with a manifest-declared Page until Slice 18 (15 slices later), so in this slice `pageId:"page_settings_logs"` must resolve to the **existing** Settings Logs deep-link (today's `open-settings-store`). Define the `pageRef` dispatch as: look up the pageId in the composed manifests; if no App yet owns it, fall back to the current `open-settings-store` deep-link keyed by a stable id map. When Slice 18 declares `page_settings_logs` on `app_platform`, the same `pageId` resolves to the manifest Page with no change to `app_frontend-logs`. Document this fallback so the graft is exercised against a real target, not a dangling id. Move `FrontendLogsTile`/`FrontendLogsTileView`, `routers/logs.ts`, and the `frontendLog` pgTable.
- [ ] **Slice 4a — `app_tesla`** (`tile_tesla`) — `routerKeys:["tesla"]`, no table. Single-router leaf. `view.kind:"modal"` (no `ownsTap`).
- [ ] **Slice 4b — `app_network`** (`tile_wifi`) — `routerKeys:["network"]`, no owned table. Single-router leaf. (Two separate pushes: 4a then 4b.)
- [ ] **Slice 5 — `app_events`** (`tile_event`) — `routerKeys:["events"]`, `events` table.
- [ ] **Slice 6 — `app_camera`** (`tile_dogcam`) — `routerKeys:["camera"]`. Note the raw `/media/tv-artwork` HTTP route as a non-tRPC facet: keep it where it is registered today and add a comment in `manifest.ts` pointing at it (codegen does not model raw HTTP routes; do not silently drop it). No owned table.

---

## Slices 7–9 — single-feature Apps with own Worker Cycle + own tables

Same per-slice shape; these additionally create `apps/<id>/jobs.ts` (a `WorkerFacet` exporting the App's cycles/handlers) and remove the matching lines from `worker-deps.ts` / the worker `Worker[]`. `apps-gen.ts` emits them into `workers.gen.ts`; the consistency test asserts each `manifest.workers` name appears in the composed cycle set.

- [ ] **Slice 7 — `app_deploys`** (`tile_deploys`, `view.kind:"self"`) — `routerKeys:["github"]`, `jobs.ts` cycle `github-actions-poll` (`run: runGithubPollCycle`, `intervalMs: 10_000`, `runOnStart: true`), github tables. Delete the worker's inline `github-actions-poll` entry and the `worker-deps.ts` re-export.
  - **Verification adds:** worker still schedules `github-actions-poll` (grep the worker startup log line `{ workers: [...] }` includes it); deploy status still updates on the Deploys tile.
- [ ] **Slice 8 — `app_notifications`** (`tile_notif`, `view.kind:"self"`) — `routerKeys:["notifications"]`, `jobs.ts` handler `notify` (`register: registerNotifyHandler`, jobType `"notify"`) plus the `notify-queue` cycle that `claimAndRun({ types:["notify"] })`; `notification` + `devicePushToken` tables. Because media-worker is folded in, the `notify` handler and its claim loop both live in the single worker (no runtime split). Remove the inline `notify-queue` worker + `registerNotifyHandler()` call from `worker/src/index.ts`.
  - **Verification adds:** the `notify-queue` cycle is present and still claims only `notify`; enqueue a test `notify` job locally and confirm it is claimed (do not send a real push in CI).
- [ ] **Slice 9 — `app_activity`** (`tile_wakes`, `view.kind:"self"`) — **multi-key**: `routerKeys:["wakePhotos","sessions"]` mounting **both** root keys so client paths `trpc.wakePhotos.*` and `trpc.sessions.*` never rename. Set `sensitive: true`. Retire the `tile_wakes` entry from Slice 1's hardcoded sensitive set and let the shell gate it off `manifests.gen.ts`.
  - **Verification adds:** `expectTypeOf` (or a client call) proves `trpc.wakePhotos.*` and `trpc.sessions.*` still resolve unrenamed; Panel: Activity tile still PIN-gates via the manifest flag (not the retired hardcoded set).

---

## Slice 10 — `app_weather` (first multi-tile App, Modal→Page)

**Goal:** Merge `tile_weath` + `tile_hourly` into one App; fold weather's 3 Variants into one Page.

**Files:** `apps/weather/{manifest.ts, web.tsx, api.ts, jobs.ts, schema.ts}`. `routerKeys:["weather"]`; `jobs.ts` cycle `weather-ingest` (`intervalMs: 5*60_000`, `runOnStart: true`); `tables:["weatherReading","weatherDailyReading"]`. Both tiles `view.kind:"page"`; fold the 3 Variants into in-page sections behind a `Segmented` control (shared UI primitive from `components/ui/`). Move `WeatherNow`/`WeatherNowView`/`Next12Hours`/`Next12HoursView`.

**Steps:** manifest with 2 `TileSpec`s → build the single Page merging the Variants → `apps:gen` → verify.

**Verification:** `bun run typecheck`; consistency test (2 tiles, 1 router key, 1 worker, 2 tables, distinct default origins); Storybook story for the merged Page; Panel: both weather tiles render and open the Page (no `TileModalHost` for them); the former Variants are reachable as in-page sections.

**Rollback:** revert → `_legacy` restores both weather tiles as modal Variants on next `apps:gen`.

---

## Slices 11–12 — AV Control (highest churn)

`CONTEXT.md` forbids bare "media": the single `mediaRouter` is split into `av` (AV Control) + `mediaSources`. This is the main churn of the pair.

> **Why this is EXPAND/CONTRACT, not a rename.** The web and API deployments roll independently, and an already-loaded panel bundle is not force-reloaded. Keep the compatibility route mounted during the rollout window so stale panels keep working until they receive the new AV route.

- [ ] **Slice 11 — `app_av-control`** (Tiles `tile_tv`, `tile_sound`, `tile_tvapps`, `tile_quickplay`, all `view.kind:"self"`) — introduce a new `av` router key carrying the transport/volume/group/launch procedures, **while KEEPING the existing `media` key mounted (unchanged) alongside it** (EXPAND). `routerKeys:["av"]` on this App; `_legacy` keeps `media` for now. `jobs.ts` cycle `sonos-volume-enforcer` (`intervalMs:1_000`, `runOnStart:true`); no owned table. Move the four `components/media/*` tile+view files under the App. Point `av`'s procedures at the same underlying handlers `media` uses (share the implementation; do not fork logic). **Update every web import site** from `trpc.media.<av-proc>` to `trpc.av.<av-proc>` in the same push — but because `media` is still mounted, a stale panel bundle calling `trpc.media.*` keeps working through the rollout window.
  - **Verification adds:** grep confirms no `trpc.media.<av-proc>` call sites remain in web; both `trpc.av.*` and `trpc.media.*` resolve at the api (expand invariant); consistency test sees both `av` (on `app_av-control`) and `media` (on `_legacy`) as mounted keys; Panel: TV/Sound/TV Apps/Quick Play tiles all control playback; the sonos-volume-enforcer still appears in the worker startup log.
  - **Rollback note:** because `media` was never removed, revert of Slice 11 is a clean no-behaviour-change revert — no path was ever un-mounted.
- [ ] **Slice 12b — retire the `media-worker` deployable (infra + guards, own push)** — the USER-LOCKED "media-worker folds into worker" decision is completed here, sequenced immediately after Slice 12 so a red infra change never blocks a tile slice. This is NOT infra-only; deleting the service trips **three repo-level guard scripts**, all of which must be edited in the same push:
  - `scripts/check-control-center-product-boundary.ts` — remove the `media-worker` entry from `expectedServices` (and its `${productRoot}/media-worker/Dockerfile` reference).
  - `products/control-center/product.json` — remove the `media-worker` service from the `services` array.
  - `scripts/check-dockerfile-manifests.ts` — remove `products/control-center/media-worker/Dockerfile` from `FULL_INSTALL_DOCKERFILES`.
  - Infra: delete `media-worker` from `infra/src/services.ts`/`program.ts`, the `mediaworker` path-filter in `.github/workflows/ci.yml`, and `wwwinfra:mediaWorkerReplicas` from Pulumi config.
  - Delete `products/control-center/media-worker/` (Dockerfile, `src`, `package.json`) and remove it from the four other full-install Dockerfiles' manifest COPY lists + root `package.json` workspaces + `bun.lock` (`bun install` regenerates the lock). Every service Dockerfile currently `COPY`s `products/control-center/media-worker/package.json`; those lines must go or `check-dockerfile-manifests` fails on a manifest that no longer resolves.
  - **Verification:** `bun run check:control-center-product-boundary`, `bun run test:dockerfile-manifests`, `bun install --frozen-lockfile`, and `bun run typecheck` all green; no orphaned Pulumi resource remains after `pulumi up`.

---

## Slice 13 — extract `packages/core/device-state` (its own commit)

**Goal:** `device_state` is written by Controls, Climate, and the device-sync cycle — three independent writers. Per Gap 1's pull-down rule it becomes a **typed core store** owned by no App, not an App→App `dependsOn` edge.

**Files:**
- Create workspace `packages/core/` (add to root `package.json` workspaces list and `vitest.config.ts` projects — this is the one new workspace, justified because it is a genuine shared substrate with two+ independent writers, the two-adapters test for data). Unlike `apps/`/`app-kit/`, this **is** a real workspace with a `package.json`, so it enters `bun.lock`.
- **Modify every full-install Dockerfile (REQUIRED):** `check-dockerfile-manifests.ts` derives its required manifest set from `bun.lock`'s workspaces and asserts each of its **7** `FULL_INSTALL_DOCKERFILES` `COPY`s every workspace's `package.json`. A new `packages/core` under the `packages/*` glob enters `bun.lock`, so `bun install --frozen-lockfile` and that guard both go red until **all seven** Dockerfiles gain a `COPY packages/core/package.json …` line: `products/control-center/{api,worker,media-worker,web}/Dockerfile`, `products/control-center/web/Dockerfile.storybook`, `products/captive-portal/Dockerfile.api`, `products/captive-portal/apps/frontend/Dockerfile`. (If Slice 12b already deleted `media-worker`, it is 6.)
- Create `packages/core/device-state/index.ts` exposing `readDesired`, `writeDesired`, `readEffective`.
- Move the `deviceState` / `deviceCommands` pgTables into `packages/core/device-state/schema.ts` (owned by core, no App). `schema.gen.ts` re-exports core tables alongside App tables so the single migration folder stays whole.
- Move the `job` queue table, HA client, `env`, migrator, and logger wiring into `packages/core` **only as far as needed to unblock the device Apps** — keep the scope to `device-state` in this slice; the rest accretes as later Apps need it (avoid a monolithic core-extraction race).

**Steps:** create workspace → move tables + write the store interface with a test (two independent writers observe each other's writes through `readEffective`) → repoint Controls/Climate/device-sync imports at the store → `db:generate` if the table move changes generated migration meta (then `bunx biome format --write` the meta dir per the known drizzle-meta gate) → `apps:gen`.

**Verification:** `bun run typecheck`; `packages/core` unit test for the store; consistency test still green (no App claims `deviceState`/`deviceCommands`); Panel: lights/climate still reconcile (device-sync + enforcers unaffected). `bun run knip`.

**Rollback:** revert; the tables and store return to the api. Note this touches Drizzle table *location* not table *shape* — no destructive migration, but confirm `db:generate` produced no column diff before pushing.

---

## Slices 14–16 — the device Apps (now that core exists)

Each writes via the core `device-state` store, owns its own Enforcer Cycle and its own router slice; none owns the `device_state` table.

- [ ] **Slice 14 — `app_controls`** (`tile_ctrl` `view.kind:"self"`, `tile_dogmode`) — `routerKeys:["controls"]`, `jobs.ts` cycle `light-enforcer` (`run: runEnforcerCycle`, `intervalMs:1_000`) + `party-mode` reconciler + `device-sync` (fan-only) if they belong here; writes desired light state via the core store. **Decision required:** keep-or-kill the `dogmode` placeholder tile against the no-fake-data invariant — if `DogModeTile` renders placeholder data, drop the tile in this slice; if it is real, migrate it. (See Open Question 3.)
- [ ] **Slice 15 — `app_climate`** (`tile_ac`) — `routerKeys:["climate"]`, `jobs.ts` cycle `climate-enforcer` (`run: runClimateEnforcerCycle`, `intervalMs:1_000`); core store.
- [ ] **Slice 16 — `app_schedules`** (`tile_sched` `view.kind:"self"`) — `routerKeys:["schedules"]`, `jobs.ts` cycle `schedule-runner` (`run: runScheduleRunnerCycle`, `intervalMs:15_000`); `lightSchedules` table; core store.

**Verification (each):** typecheck; consistency test; worker startup log lists the moved cycle; Panel: the device tile still actuates (light on/off, thermostat, schedule fire) — verify against a real device or the dev HA stub, not fake data.

---

## Slice 17 — `app_ios-shell` (no Tile — headless service App)

**Goal:** Prove the deletion test on a tile-less App: `chrome: [AppUpdateBanner]`, `workers: ["asc-version-poll"]`, `tables: ["ascBuildStatus"]`, zero tiles. Deleting the folder removes all three.

**Files:** `apps/ios-shell/{manifest.ts, web.tsx, jobs.ts, schema.ts}`. `web.tsx` exports `chrome: { chrome_app_update: AppUpdateBanner }` (a `ChromeSlot`, `zone:"top"`, an `order` deconflicted with the platform Banners in Slice 18). `jobs.ts` cycle `asc-version-poll` (`run: runAscVersionPollCycle`, `intervalMs:60_000`). Move `AppUpdateBanner.tsx` under the App. Remove the inline `AppUpdateBanner` render from `Board.tsx` (it now comes from `chrome.gen.ts`).
- **Interim banner ordering (this is the panel-visible risk).** Board.tsx today renders five ordered siblings in one `zIndex:200` `pointerEvents:none` layer: `DeviceNameBanner`, `ConnectionLostBanner`, `AppUpdateBanner` (3rd), `UnplacedTilesBanner`, `NotChargingBanner`. This slice pulls only `AppUpdateBanner` out into the generated Chrome stack while the other four stay hard-coded. To preserve the exact visual sequence for the one deploy window before Slice 18 collapses the rest: render the generated Chrome stack **inline at AppUpdateBanner's former 3rd position** — i.e. keep the four hard-coded `<Banner/>` siblings and drop the single generated-stack `.map()` in between the 2nd (`ConnectionLostBanner`) and 4th (`UnplacedTilesBanner`) siblings, inside the same `zIndex:200` layer. Give `chrome_app_update` an `order` that leaves room for the platform slots' orders assigned in Slice 18. Verify on the Panel that the update banner appears in the identical position and z-order as before this slice.

**Verification:** typecheck; consistency test; Chrome test (the `AppUpdateBanner` slot renders in its zone/order); worker log lists `asc-version-poll`; Panel: the update banner still appears when a newer TestFlight build exists.

**Rollback:** revert → `_legacy`/`Board.tsx` restore the inline banner.

---

## Slice 18 — `app_platform` (substrate App) + ChromeSlot Banner collapse

**Goal:** The Panel-level substrate becomes one headless App, and `Board.tsx`'s remaining hard-coded `<XBanner/>` lines collapse into an iterated, ordered Chrome stack.

**Files:**
- `apps/platform/{manifest.ts, web.tsx, api.ts}`. `routerKeys:["health","layout","settings","system","portal"]`. `web.tsx` exports the four shell Banners as `ChromeSlot`s: `ConnectionLostBanner`, `DeviceNameBanner`, `UnplacedTilesBanner`, `NotChargingBanner`, each with a `zone`+`order` reproducing today's exact stacking order (verify against `Board.tsx` lines ~993–997: DeviceName, ConnectionLost, AppUpdate (from Slice 17), Unplaced, NotCharging → assign `order` values that preserve this visual sequence within the `top` zone).
- The Settings Page is gear-opened (`sensitive: true` — retire the last hardcoded sensitive-set member from Slice 1). Settings has no Tile; its Page opens from the Chrome gear affordance.
- Modify `Board.tsx`: replace the five hard-coded `<Banner/>` lines with a single loop over `banners` from `chrome.gen.ts`, sorted by `(zone, order)`. This is the ChromeSlot banner collapse.
- The retention Cron stays a `Cron` (Kubernetes scheduled job in `infra/src/crons.ts`) — it is **not** a Worker Cycle and does not move into `jobs.ts`; note it in `manifest.ts` as owned-by-platform for documentation only.

**Verification:** typecheck; consistency test; **Chrome ordering test** (feed the four platform slots + the ios-shell slot, assert deterministic render order matches today's visual order); Panel visual regression: all five Banners appear in the same positions and z-order as before the collapse; Settings still opens from the gear and PIN-gates via the manifest flag.

**Rollback:** revert → `Board.tsx` restores the five hard-coded banner lines; the platform routers re-mount via `_legacy`.

---

## Slice 19 — dissolve the interim seams (deletion test for the whole initiative)

**Goal:** Every Tile View is now a Page (or self/pageRef), every cycle is behind a `jobs.ts`, every router is behind an `api.ts`. Delete the scaffolding.

**Precondition:** Slice 12b (media-worker deployable retired) must have landed — `media.ts`'s last external importer was `@control-center/media-worker`, so deleting `media.ts` before that package is gone reds the `--filter '*'` typecheck. Confirm `@control-center/media-worker` no longer exists before this slice.

**Files to delete:** `apps/_legacy/`, `products/control-center/api/src/worker-deps.ts`, `products/control-center/api/src/media.ts` (now that no deployable imports it), `TileModalHost`, `VariantSwitcher`, `web/src/components/modals/registry.ts`, and the `ownsTap` flag (now fully expressed as `view.kind:"self"`). `products/control-center/api/src/db/schema.ts` becomes a pure barrel re-exporting App + core schemas (or is deleted if `schema.gen.ts` fully subsumes it). Delete the `worker-deps.ts` re-export subpath from `api/package.json` exports.

**Steps:** confirm no App still declares `view.kind:"modal"` (grep `manifests.gen.ts`) → delete `_legacy` → `apps:gen` (regenerates `_generated` from real folders only) → delete the modal host machinery → typecheck → consistency test + `apps:check`.

**Verification:** `bun run typecheck`; `bun run test` (full suite); `bun run test:apps-check`; `bun run knip` (must report the deleted files as gone, no new dead code); Panel smoke test of every tile + banner + PIN gate. This slice is the codebase-level deletion test: if deleting `_legacy` + the barrels breaks nothing, the Apps genuinely own their pieces.

**Rollback:** this is the one slice that is awkward to revert (it removes the fallback). Land it only after a full green Panel smoke test. Revert restores `_legacy` and the modal host wholesale.

---

## Slice S — server-side PIN (separate, explicitly sequenced, NOT part of any tile migration)

**Goal:** Make `sensitive` drive **both** the client gate and server enforcement, closing the "looks server-enforced but a direct tRPC call returns the data" gap. Sequenced last, on purpose, so the structural refactor never ships false security confidence.

**Files:**
- `apps/platform/api.ts` (or a `packages/core/session/`) — add `session.unlock(pin)`: the **first server-side PIN compare**, minting a short-lived signed token into tRPC context.
- Add a `requireUnlock` middleware and `procedureFor(manifest)` that returns `publicProcedure.use(requireUnlock)` when `manifest.sensitive` is set.
- Modify each `sensitive` App's `api.ts` to build its procedures from the gated base.
- Add a codegen guard (from this slice on): `apps-gen.ts` fails if a `sensitive` App's `api.ts` is not built from the gated base.
- Modify the client `pin-session-store` to call `session.unlock` and hold the returned token; attach it to tRPC requests.

**Verification:** typecheck; a server test that a direct `trpc.<sensitiveApp>.*` call **without** a valid unlock token is rejected; the codegen guard fires on a `sensitive` App missing the gated base; Panel: unlock flow still works end-to-end and now the server rejects unauthenticated sensitive reads.

**Rollback:** revert restores client-gate-only parity (today's behaviour); no data migration involved.

---

## Consistency test — the drift backstop (grows across slices, asserted in CI every push)

One Vitest suite (`apps/_generated/consistency.test.ts`) run in the CI test gate, asserting on the composed `manifests.gen.ts` + `router.gen.ts` + `workers.gen.ts` + `schema.gen.ts`:

- `keys(appRouter)` **===** the union of every `manifest.routerKeys` (no orphan key, no unmounted key).
- every `manifest.workers` name appears in the composed cycle/handler set.
- every `manifest.tables` name is a real exported `pgTable` owned by **exactly one** App (or core) — no table declared by two Apps, none declared by none.
- exactly **one** `home` Tile across all Apps.
- no two Tiles share the **exact** default origin `(worldCol, worldRow)`; no default off-world.
- (from Slice S) every `sensitive` App's `api.ts` is built from the gated base.

Plus the shell suite tested **once** against **fake Apps** (`app-kit/testing.ts` `fakeApp()`), the real-vs-fake adapter pair at the seam codegen fills:

- **Board/Overlay host:** `[fakeApp(), fakeApp({ sensitive:true, tiles:[oneTile] })]` → registry builds, tap opens the Page, `view.kind` dispatch picks page/modal/self/pageRef, unplaced banner appears, placement guard fires on a duplicate default origin, `assertExactlyOneHome` throws on two homes.
- **Chrome:** two fake `ChromeSlot`s in different zones/orders render deterministically.
- **PIN:** a `sensitive` fake refuses to open while locked, opens after `<PinGate>` success, one global unlock covers a second sensitive fake within the timeout, re-prompts after timeout and on return-to-Home.
- **Worker runtime:** a fake `jobs.ts` with a spy cycle proves `workers.gen.ts` schedules it and isolates a throwing cycle.
- **Router mounting:** mount a fake `api.ts`, assert the namespaced path resolves with a static type (`expectTypeOf` locks the Gap-2 claim).
- **Per-App deletion test:** delete a folder + regenerate → typecheck + consistency test prove nothing dangles.

---

## Self-Review (spec coverage against the FINAL design)

- app-kit-as-source-dir ✓ (Slice 0, File Structure). codegen — reads `apps/*/manifest.ts` + facets, emits six `_generated/*.gen.ts`, `apps:check` CI guard, dev watch story ✓ (Slice 0). `_legacy` shim slice 0 ✓. 19-tile migration in deployable slices, order per design ✓ (Slices 2–18: clock→felogs→tesla→network→events→camera→deploys→notifications→activity→weather→av-control→media-ingest→[core]→controls→climate→schedules→ios-shell→platform). ChromeSlot banner collapse ✓ (Slice 18, with `AppUpdateBanner` moved in Slice 17). device_state core store extraction ✓ (Slice 13). deferred server-side PIN, scoped but explicitly separate ✓ (Slice S). consistency test ✓ (dedicated section, grows from Slice 0). Every slice carries files-touched, verification (typecheck/tests/visual on Panel), and a rollback note ✓.
- The 9 design gaps map to slices: Gap 1 → Slices 11–16 + 13; Gap 2 → Slice 0 `router.gen.ts` literal; Gap 3 → Slices 1 + S; Gap 4 → `schema.gen.ts` + consistency test; Gap 5 → placement guard (Slice 0) + manifest defaults; Gap 6 → `TileViewSpec` union carried through, modal host deleted only in Slice 19; Gap 7 → Slices 17–18; Gap 8 → barrels deleted Slice 19, core extraction Slice 13; Gap 9 → Slices 11–12.

---

## Open Questions

1. **Worker runtime decision — RESOLVED.** There is one worker deployable, so the optional `runtime` field is documentation only (default `"worker"`); codegen always emits one `Worker[]` and does not dispatch on it.
2. **`schema.gen.ts` vs the single migration folder.** Confirm that repointing `drizzle.config.ts` at `schema.gen.ts` and moving table *authoring* into App folders produces **no** column diff on `db:generate` (authoring/ownership move only, one Postgres, one sequential migrations folder). Any table move (esp. Slice 13 `device_state`) must be verified diff-free before push; if `db:generate` emits meta, remember the biome-format gate on the meta dir.
3. **`tile_dogmode` and the no-fake-data invariant** (Slice 14). Does `DogModeTile` render real data or a placeholder? If placeholder, the slice drops the tile; if real, it migrates. Needs a look at the component before Slice 14.
4. **`app_platform` router scope.** Slice 18 assigns `health/layout/settings/system/portal` to `app_platform`. Confirm none of these should instead pull *down* into `packages/core` (e.g. `health`/`system` may be substrate rather than a feature App). The design calls platform "shell/core"; decide whether platform is an App or whether some of its routers belong in core alongside device-state.
5. **Facet file moves vs re-exports.** Each App slice prefers *moving* the tile component/view/router/service files into the App folder (locality). Confirm this is acceptable churn per slice, or whether some slices should re-export from the current path first and physically move later — the plan assumes move-in-place for maximum locality but that enlarges each diff.
6. **Exact current PIN gate paths** (Slice 1). The design cites `SettingsButton.tsx` and `WakesTile.tsx`; verify with `grep -rl PinGateModal` before starting, since a third gate site would change the slice.

---

## Review log

Adversarial review across three lenses (CORRECTNESS, DEPLOY-SAFETY, COMPLEXITY). Each fatal/major verified against the repo before acting.

**Fatal**
- **Slice 0 breaks every service image build** (apps/app-kit not in any Dockerfile build context; `bun build` cannot resolve the generated aggregates). Reported by both CORRECTNESS and DEPLOY-SAFETY. **accepted+fixed** — verified Dockerfiles COPY only their own service dir + `packages/`; Architecture caveat rewritten, Slice 0 now adds `COPY apps`/`COPY app-kit` to api/worker/web/storybook (+ media-worker defensively), fixed the off-by-one `../../`→`../../../` tile-registry path, and added a Docker-build smoke check.

**Major**
- **media.ts deleted before media-worker deployable retired** (reds `--filter '*'` typecheck + media-worker image). **accepted+fixed** — verified media-worker imports `@control-center/api/media`; Slice 12 now explicitly does NOT delete media.ts, Slice 19 gained a precondition, and retirement is sequenced as Slice 12b.
- **media-worker retirement trips 3 repo guards, not just infra.** **accepted+fixed** — verified product-boundary/product.json/dockerfile-manifests all reference media-worker; new Slice 12b lists all three plus infra + workspace/lock/manifest-COPY cleanup.
- **mediaRouter split under-specified; dropping `media` strands the flat router's ingest half.** **accepted+fixed** — verified `routers/media.ts` is one flat 337-line router mixing AV procs with the ingest-mutation half (since retired, see #322); Slices 11–12 rewritten as explicit EXPAND (keep `media` + add `av`) / CONTRACT (add `mediaSources`, drop `media`).
- **Cross-deploy window on the `media`→`av` rename** (web/api roll independently; loaded panel bundle not force-reloaded). **accepted+fixed** — same EXPAND/CONTRACT fix keeps `media` mounted through the rollout; corrected the plan's false "same push ⇒ no window" claim.
- **packages/core (Slice 13) needs a COPY line in all 7 full-install Dockerfiles + the guard.** **accepted+fixed** — verified `check-dockerfile-manifests.ts` derives from bun.lock over 7 Dockerfiles; Slice 13 now lists all seven.
- **Whole codegen is over-engineered vs static barrels (COMPLEXITY).** **rejected** — the static-manifest alternative was explicitly evaluated and rejected in the FINAL design (a locked architectural decision), and this is an opinion, not a repo-verifiable defect. Out of scope for the fixer.
- **import-boundary.ts parser is redundant with the Biome hard CI gate.** **accepted+fixed** — verified `bun run lint` is a hard CI gate; dropped the standalone parser + its test, moved enforcement to a Biome `noRestrictedImports` error rule plus a cheap gen-time string assertion.

**Minors folded in:** key/worker miscounts (20→19, 11→10); `../../`→`../../../` path; generated-TS biome-format step inside `apps:gen` (drizzle-meta papercut mitigation); vestigial `runtime` union resolved to an inert doc label (Open Question 1); Slice 3 `pageRef` interim resolution against the existing `open-settings-store`; Slice 17 interim banner ordering pinned to AppUpdateBanner's 3rd position; workspace-glob note that `apps/`/`app-kit/` must stay `package.json`-free. Left as-is: Slice 4a/4b split and Slices 14–16→13 coupling (both benign under the small-green-push / minimal-core-scope framing).
