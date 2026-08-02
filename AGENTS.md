# Agent Instructions

## Start Here

- Read `CODEBASE_OVERVIEW.md` first.
- **Ticket tracking is software-factory** (since 2026-07-31). It is also the
  brain-dump inbox: file ideas there rather than losing them in chat. See
  `## Ticket tracking` below for the verbatim rule.
- **Beads (`bd`) dropped 2026-07-11.** Never create or query `bd` tickets. Archive:
  `docs/beads-archive/` - `OPEN-IDEAS.md` (unfinished ideas), `beads-export.jsonl`
  (raw dump). Pull ideas from there.
- **software-factory Tickets are the only tracker** - use the `/create-ticket`
  skill, which invokes `scripts/create-ticket.sh --title "..." --body-file FILE
  [--blocker ID]...` against `factory.worldwidewebb.co`. Tickets carry no labels
  and their body must be self-contained, opening with a `## Original ask
  (verbatim)` block. The script decrypts the worker bearer token from
  `secrets/vault.yaml` via `sops` and port-forwards to the in-cluster API - never
  prints the token.
- Read the `docs/writing-scalable-typescript/` guide (start at its `README.md`)
  before writing or reviewing TS/TSX. It is docs, not an invokable skill.
- **Software-factory source lives in `0x63616c/software-factory`.** This repo
  owns only its release lock, verification adapter, and production deployment.

## Invariants

- **Design for 10x-100x this repo's size** - never reject a shared primitive on
  "few call sites today". Get data layout (paths, schema, IDs, on-disk formats)
  right up front; code interfaces refactor cheaply later.
- Shared primitives live in `packages/platform`, enforced by a Biome rule banning
  the raw escape hatch (see sound bus).
- Fixed wall panel, `1366x1024`, not responsive. Enforced by the OS on the
  native/Capacitor kiosk shell and the physical panel hardware. The web build
  matches it too, via `apps/web/src/components/PanelFrame.tsx`: it caps the app
  to `1366x1024` and, on a desktop browser with room to spare, frames it like a
  device instead of letting the board stretch to fill the window. `PanelFrame`
  is a no-op passthrough on native, so this never touches the panel/native
  behavior above.
- Features are self-contained Apps under `features/<id>/` (manifest + facets:
  `web.tsx`, `detail.ts`, `api.ts`, `jobs.ts`, `schema.ts`, `temporal.ts`); the folder existing is the App's
  registration (ADR-0001). Tile placement is declared as registry coords in the
  App's `manifest.ts`, glob-collected and emitted to checked-in
  `features/_generated/*.gen.ts` by `bun run apps:gen` (ADR-0002). The Board and
  Tile Detail Host consume `web.gen.ts`; never hand-edit `_generated/`.
  `bun run apps:check` re-runs codegen and fails on drift.
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
- IDs default to `prefix_<id>` — mint them with `genId()` from `packages/platform` (never
  hand-roll `prefix_${crypto.randomUUID()}`); a lefthook guard blocks hand-rolled ids outside
  `packages/platform/src/index.ts`.
- Backend code uses structured logging.
- **Never read secret values** (e.g. contents of `secret/vault.yaml`). Checking
  key names/presence is fine; do not print or inspect the decrypted values.

## Debugging

- **Backend debugging starts in Grafana** - `https://grafana.worldwidewebb.co`
  (Cloudflare Access email OTP). Metrics from Prometheus, every container's logs
  from Loki (labels `namespace` `pod` `container` `app` `service` `level`; 14-day
  retention). See `docs/observability.md`.
- Panel/frontend logs are a SEPARATE pipeline and are NOT in Loki: they live in
  the control-center Postgres, table `frontend_log`, 30-day retention, tagged
  with stable `device_id`, display `device_name`, git `sha`, app `build`. Query
  it (psql via kubectl exec on `control-center-1`); never ask for a device export.

## Infra

- **"prod" = the `home-server` Talos node** (`192.168.0.5`, single control-plane,
  amd64, RTX 3060). No other production environment.
- **There is NO SSH into home-server.** Talos ships no shell and no sshd; port 22 is
  closed by design. Administer it with `talosctl` (node) and `kubectl` (cluster) -
  `export TALOSCONFIG=$PWD/infra/talos/clusterconfig/talosconfig` then
  `talosctl dashboard`. The binary is `talosctl`, not `talos`, and needs no `-e`/`-n`
  (endpoint + node are baked into the talosconfig).
- `infra/talos/clusterconfig/` is gitignored and regenerated per session
  (`talhelper genconfig`) - it holds the cluster CA and admin client key. Machine
  config source of truth is `infra/talos/talconfig.yaml`.
- The Mac mini ("homelab", k3s/OrbStack, HAOS VM at `192.168.0.38`) was **retired and
  powered off 2026-07-25** and kept as a cold spare - do NOT wipe it. Any `homelab`
  reference in this repo is stale by definition, including `scripts/ssh-homelab.sh`,
  which points at powered-off hardware. Home Assistant now answers on
  `192.168.0.5:8123`, not `.38`.
- Deploy the `home-server` Pulumi stack. A stack named `prod` still exists but targets
  the retired mini - **never deploy it** (its cloudflared would split-brain the live
  Cloudflare tunnel). Images are **amd64-only**; the node is x86.
- Push to `main` triggers CI + deploy.
- CI/deploy is product-aware: per-product path filters build only changed product
  images plus shared-package dependents.
- Pulumi digest pins use `wwwinfra:imageDigests.*`.
- Infra-level cron jobs (backups, map-extract) live in `infra/src/crons.ts`; app-level
  scheduled work is Temporal Schedules declared in `features/<id>/temporal.ts` (ADR-0008).

## Ticket tracking

software-factory Tickets are the tracker and brain-dump inbox. "Ticket" means
one unit of work in the factory's own record.

- Use the `/create-ticket` skill to file one; it applies the verbatim rule and
  creates the Ticket through the factory API.
- **Preserve the requester's exact wording.** Every Ticket body opens with an
  `## Original ask (verbatim)` blockquote holding the request character-for-character
  - typos, trailing fragments and all. Never paraphrase it away. Interpretation goes
  below it, clearly marked as ours. Summarising the ask is the one unacceptable edit.
- Title is a cleaned-up handle; a one-line description sits above the verbatim block.
- Tickets carry no labels; their state, runs, and dependency edges belong to
  software-factory. Add a known prerequisite with `--blocker T-<id>`.
- One Ticket per request, even when several arrive together, so they complete
  independently. Brain dumps record their origin (for example `item #22`) in the body.
- A merged PR is done when the factory's merge webhook moves its Ticket to `done`.
  Do not hold a Ticket open pending production verification. If the change turns
  out broken, file a new Ticket.

## Workflow

- **Never edit in the main checkout - always `wtp add` a worktree first.**
  `wtp add <branch>` for an existing branch, `wtp add -b <new-branch>
  origin/main` for a new one - base new work on `origin/main`, since the local
  main checkout is usually well behind. `.wtp.yml` puts every worktree under
  `~/.worktrees/world-wide-webb/` (never nested in `.claude/worktrees/` or any
  repo subfolder - that's what caused lefthook/env setup to be flaky) and its
  `post_create` hooks run `bun install` + `lefthook install` automatically, then
  retarget the new branch's upstream from inherited `origin/main` to its eventual
  same-named `origin/<new-branch>` ref. This keeps `git status`, `git pull`, and
  a normal push scoped to the feature branch even before its first push. A fresh
  worktree is immediately usable. See #182.
  - A `PreToolUse` guard (`.claude/hooks/guard-worktree-only.sh`, shared by
    Claude Code and Codex) enforces this. It judges Edit/Write/`apply_patch` by
    the **target file's** path, not by your cwd, so writing into a worktree from
    a main-checkout session is allowed and writing into the main checkout never
    is. If you hit it you're pointed at the wrong directory, not wrongly
    permissioned. Table test: `bash .claude/hooks/guard-worktree-only.test.sh`.
  - **Agents (Claude Code): do not try to relocate the session.** `wtp cd` only
    moves a shell subprocess, and `EnterWorktree` is unusable here - it accepts
    only worktrees it created under `.claude/worktrees/`, so `{path: ...}` to a
    wtp worktree is rejected by the harness, and `{name: ...}` would create a
    nested checkout that skips wtp's hooks. Both forms are guard-denied. Stay
    where you are and drive the worktree by absolute path instead: `git -C
    <worktree> ...`, and absolute `<worktree>/...` paths for Edit/Write.
  - **Never `git worktree remove` or `git branch -D`.** Other sessions own
    worktrees and branches you cannot see, and an idle-looking worktree is
    usually someone's live work - hand-cleanup has already destroyed a peer
    session's branch. Guard-denied from every directory, main or worktree.
    Stale worktrees are reaped by an hourly prune job.
- **Branch -> PR -> merge is the default for all work, including agent work.**
  Create a worktree/branch named after the task, commit there, and open a PR
  against `main` (`gh pr create`, using the PR template). Reference the Ticket
  as `Refs T-<id>`; the merge webhook records completion in software-factory.
- **Commit and push extremely often, without asking.** Commit each coherent
  change (passing test, working slice, doc update); never batch. Push the
  branch immediately - the push target is now the PR branch, not `main`.
- Opening a PR, and self-merging it once it's green, is pre-approved for every
  requested change made by a human (you, an agent working a task Calum gave
  it directly). Never pause to ask. `main` carries a branch-protection
  ruleset requiring one Code Owner (@0x63616c) approval, but Calum is a
  bypass actor - the goal for human-driven work stays an auditable trail
  ("here's the PR for that change"), not an approval gate. GitHub's default
  merge button still shows "review required" for a bypass actor; use the
  "Merge without waiting for requirements to be met" button (or `gh pr merge
  --admin`, or the plain `PUT .../pulls/{n}/merge` API call) rather than
  reading that as blocked.
  - **software-factory's PRs are the one exception.** Its GitHub App is not a
    bypass actor, deliberately: those PRs need Calum's actual review before
    they merge. The service enables GitHub auto-merge (squash) on its own
    PRs once they leave draft, so once approved they merge themselves - no
    manual merge step for those.
- **Merging to `main` deploys to prod** (push-to-main triggers CI + deploy), so
  merging the PR is the deliberate act. Merge once CI is green; don't merge a
  red PR.
- Verify before opening/merging where cheap (`bun run typecheck`, relevant
  tests). On failure, fix forward on the branch and push again - never sit on
  an unpushed or unmerged change.
- Keep docs current when behavior changes.
