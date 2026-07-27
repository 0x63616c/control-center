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
- Fixed wall panel, `1366x1024`, not responsive. Enforced by the OS on the
  native/Capacitor kiosk shell and the physical panel hardware. The web build
  matches it too, via `apps/web/src/components/PanelFrame.tsx`: it caps the app
  to `1366x1024` and, on a desktop browser with room to spare, frames it like a
  device instead of letting the board stretch to fill the window. `PanelFrame`
  is a no-op passthrough on native, so this never touches the panel/native
  behavior above.
- Features are self-contained Apps under `features/<id>/` (manifest + facets:
  `web.tsx`, `api.ts`, `jobs.ts`, `schema.ts`, `temporal.ts`); the folder existing is the App's
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
  Cloudflare tunnel). Images must be **multi-arch/amd64**; the node is x86.
- Push to `main` triggers CI + deploy.
- CI/deploy is product-aware: per-product path filters build only changed product
  images plus shared-package dependents.
- Pulumi digest pins use `wwwinfra:imageDigests.*`.
- Infra-level cron jobs (backups, map-extract) live in `infra/src/crons.ts`; app-level
  scheduled work is Temporal Schedules declared in `features/<id>/temporal.ts` (ADR-0008).

## Issue tracking

GitHub Issues (`gh issue`) is the tracker and the brain-dump inbox. "Ticket"
means a GitHub issue - same thing, one vocabulary.

- Use the `/create-ticket` skill to file one; it applies the verbatim rule and
  label scheme below automatically.
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
  - List below can drift; confirm with
    `gh label list --limit 100 --json name | jq -r '.[].name' | grep -E '^(area|type)/'`
    (repo also carries unrelated default labels like `bug`/`enhancement` - ignore those).
- One issue per request, even when several arrive together, so they close
  independently. Brain dumps record their origin (e.g. `item #22`) in the body;
  those numbers are not GitHub issue numbers.
- **Never let a commit message auto-close a ticket you haven't validated live.**
  `Fixes #N`/`Closes #N` in a commit body closes the issue the moment it merges
  to `main` - before deploy finishes, before you've confirmed the fix actually
  works against the real system. Push the fix WITHOUT a closing keyword, verify
  it live (rerun the failing job/request/flow), THEN close with a comment
  stating what was verified. If a keyword slips through and auto-closes early,
  reopen immediately and say why.

## Workflow

- **Never edit in the main checkout - always `wtp add` a worktree first.**
  `wtp add <branch>` (or `wtp add -b <new-branch>`) for a new branch, `wtp cd
  <branch>` to jump back into an existing one. `.wtp.yml` puts every worktree
  under `~/.worktrees/world-wide-webb/` (never nested in `.claude/worktrees/`
  or any repo subfolder - that's what caused lefthook/env setup to be flaky)
  and its `post_create` hooks run `bun install` + `lefthook install`
  automatically, so a fresh worktree is immediately usable. A `PreToolUse`
  hook blocks Edit/Write/`apply_patch` and branch-switching Bash commands
  (`git checkout`, `git switch`, etc.) in the main checkout for both Claude
  Code and Codex - if you hit that, you're in the wrong directory, not
  wrongly permissioned. See #182.
  - **Agents (Claude Code):** `wtp cd` only moves a shell subprocess, not the
    agent's own session - it does nothing for you. After `wtp add`, call
    `EnterWorktree({path: <path wtp printed>})` to actually relocate the
    session into the worktree wtp created (this does not create a new nested
    `.claude/worktrees/` checkout - it just points the existing session at an
    already-wtp-created directory). Skipping this step means every Edit/Write
    still targets the main checkout and gets denied by the guard above, even
    if the file path you pass looks like it's inside a worktree.
- **Branch -> PR -> merge is the default for all work, including agent work.**
  Create a worktree/branch named after the task, commit there, and open a PR
  against `main` (`gh pr create`, using the PR template). Use the
  `.github/pull_request_template.md` fields (`Refs #N`, never `Fixes`/`Closes`
  - see the issue-tracking rule above).
- **Commit and push extremely often, without asking.** Commit each coherent
  change (passing test, working slice, doc update); never batch. Push the
  branch immediately - the push target is now the PR branch, not `main`.
- Opening a PR, and self-merging it once it's green, is pre-approved for every
  requested change. Never pause to ask, and no required reviewers are needed -
  the goal is an auditable trail ("here's the PR for that change"), not an
  approval gate.
- **Merging to `main` deploys to prod** (push-to-main triggers CI + deploy), so
  merging the PR is the deliberate act. Merge once CI is green; don't merge a
  red PR.
- Verify before opening/merging where cheap (`bun run typecheck`, relevant
  tests). On failure, fix forward on the branch and push again - never sit on
  an unpushed or unmerged change.
- Keep docs current when behavior changes.
