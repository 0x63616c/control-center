# Agent Instructions

## Start Here

- Read `CODEBASE_OVERVIEW.md` first.
- **Issue tracking is GitHub Issues** (since 2026-07-25), via `gh issue`. It is
  also the brain-dump inbox: file ideas there rather than losing them in chat.
  See `## Issue tracking` below for the label scheme and the verbatim rule.
- **Beads (`bd`) dropped 2026-07-11.** Never create or query `bd` tickets. Archive:
  `docs/beads-archive/` - `OPEN-IDEAS.md` (unfinished ideas), `beads-export.jsonl`
  (raw dump). Pull ideas from there.
- Read the `docs/writing-scalable-typescript/` guide (start at its `README.md`)
  before writing or reviewing TS/TSX. It is docs, not an invokable skill.

## Invariants

- **Design for 10x-100x this repo's size** - never reject a shared primitive on
  "few call sites today". Get data layout (paths, schema, IDs, on-disk formats)
  right up front; code interfaces refactor cheaply later.
- Shared primitives live in `packages/platform`, enforced by a Biome rule banning
  the raw escape hatch (see sound bus).
- Fixed wall panel, `1366x1024`, not responsive.
- Features are self-contained Apps under `features/<id>/` (manifest + facets:
  `web.tsx`, `api.ts`, `jobs.ts`, `schema.ts`); the folder existing is the App's
  registration (ADR-0001). Tile placement is declared as registry coords in the
  App's `manifest.ts`, glob-collected and emitted to checked-in
  `features/_generated/*.gen.ts` by `bun run apps:gen` (ADR-0002); never hand-edit
  `_generated/`. `bun run apps:check` re-runs codegen and fails on drift.
  `scripts/apps-gen/validate.ts` is the consistency check (dup id/router-key/table,
  ≠1 `home` tile, overlapping tile rects, `guestExposed` ≠ `GUEST_EXPOSED` all
  throw). Shared DB/UniFi substrate lives in `packages/core` (`@www/core`).
- Dependency boundaries between `packages/*`, `features/*`, and `apps/*` are
  enforced by a Biome `noRestrictedImports` rule, not a separate dependency-graph
  tool.
- Use shared UI primitives from `apps/web/src/components/ui/`.
- Full-screen pages over modals for new tiles' detail views.
- Panel audio goes through the sound bus: `playCue()` from
  `apps/web/src/lib/sound/`. Add a named cue; never construct
  `AudioContext` or `Audio` elsewhere (Biome-enforced). Loudness is DEVICE volume
  via the `PanelVolume` plugin and Sound settings page, never in-app gain.
- No fake or placeholder data.
- Storybook-first for new UI.
- IDs default to `prefix_<id>`.
- Backend code uses structured logging.

## Debugging

- Panel/frontend logs live in the control-center Postgres: table `frontend_log`,
  30-day retention, tagged with stable `device_id`, display `device_name`, git
  `sha`, app `build`. Query it (psql via kubectl exec on `control-center-1`);
  never ask for a device export.

## Infra

- "prod" = homelab cluster. No other production environment.
- Push to `main` triggers CI + deploy.
- CI/deploy is product-aware: per-product path filters build only changed product
  images plus shared-package dependents.
- Pulumi digest pins use `wwwinfra:imageDigests.*`.
- Cron jobs live in `infra/src/crons.ts`.

## Issue tracking

GitHub Issues (`gh issue`) is the tracker and the brain-dump inbox.

- **Preserve the requester's exact wording.** Every issue body opens with an
  `## Original ask (verbatim)` blockquote holding the request character-for-character
  - typos, trailing fragments and all. Never paraphrase it away. Interpretation goes
  below it, clearly marked as ours. Summarising the ask is the one unacceptable edit.
- Title is a cleaned-up handle; a one-line description sits above the verbatim block.
- **Labels: exactly one `area/*` and one `type/*`. Nothing else.** No priority, no
  status, no milestones, no Projects board - deliberately, so it cannot go stale.
  - `area/`: `infra` `network` `hardware` `panel-ui` `tiles` `integrations`
    `observability` `docs` `tooling` `security`
  - `type/`: `bug` `chore` `feature` `design` `spike` `verify` `question`
- One issue per request, even when several arrive together, so they close
  independently. Brain dumps record their origin (e.g. `item #22`) in the body;
  those numbers are not GitHub issue numbers.

## Workflow

- **Work on `main` (default).** Use worktrees only when asked; name them after the
  task.
- **Commit and push extremely often, without asking.** Push to `main` deploys to
  prod. Commit each coherent change (passing test, working slice, doc update);
  never batch. Push immediately.
- Commit + push to `main` is pre-approved for every requested change. Never pause
  to ask.
- Verify before pushing where cheap (`bun run typecheck`, relevant tests). On
  failure, fix forward and push again - never sit on unpushed work.
- No PRs for shipping.
- Keep docs current when behavior changes.
