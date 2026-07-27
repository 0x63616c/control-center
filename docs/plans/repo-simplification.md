# Repo Simplification Implementation Plan

> **Historical note (2026-07-27):** "Temporal is OUT" below meant the old
> `products/project-management` consumer, which this plan deleted. Temporal has since
> returned as live infrastructure (`infra/src/temporal.ts`, `apps/temporal-worker/`) and
> now owns scheduled app work — see ADR-0008. Read this plan's Temporal statements as
> scoped to that dead product, not the repo today.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan slice-by-slice. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink the monorepo to what is actually load-bearing — delete two products, fix a stale-doc drift, retire a folklore `git push --no-verify` habit, and record honest verdicts on the "collapse `control-center/*`" and shared-package questions — without ever shipping a red push to `main`.

**Architecture:** Continuous delivery. Every push to `main` runs CI and, if green, `pulumi up --stack prod`. Therefore each slice below is a single small commit that must leave `bun run typecheck`, `bun run test`, `bun run lint`, `bun run knip`, and (for infra-touching slices) `pulumi preview` green. Removing a *live* product is a **decommission**, not a file delete: the infra teardown push is the action that deletes real Kubernetes resources.

**Tech Stack:** Bun workspaces, TypeScript, tRPC, Drizzle, Vite/React, Storybook, Pulumi + k3s, Biome, knip, lefthook, vitest, dorny/paths-filter CI.

## Global Constraints (user-locked)

- Continuous deploy — **every slice is one small green push to `main`. No PRs.**
- Temporal is OUT (it only ever lived in `products/project-management`, which this plan deletes).
- Storybook stays. The `products/control-center/storybook` wrapper stays.
- **User has DECIDED `media-worker` folds into `worker`.** Infra comments about a Phase-4 / Boundary-6 media-worker bring-up are **superseded**. (The media-worker fold itself is designed in the App-construct plan; this plan only stops treating the infra "bring it up later" comments as authoritative and updates the docs accordingly.)
- No fake or placeholder data.
- IDs default to `prefix_<id>`.
- This is a research/planning deliverable: it produces PLAN documents. Do not treat any code snippet here as already applied.

---

## 0. Read this first — the one non-obvious risk

**`products/captive-portal` is NOT a dead product.** Recon confirmed it is fully live in prod:

- Two deployed workloads (`captive-portal-portal`, `captive-portal-api`) in `infra/src/services.ts`.
- Its **own dedicated CloudNativePG Postgres cluster** (`infra/src/cnpg.ts`) with a **daily backup cron** (`captive-portal-pg-backup`, `infra/src/crons.ts`).
- TLS certs for `captive-portal.worldwidewebb.co` and `app--cp.worldwidewebb.co` (`infra/src/certmanager.ts`) and Cloudflare DNS/Access routes (`infra/cloudflare/src/routes.ts`, `access.ts`).
- Dedicated CI build+deploy jobs, a `captiveportal` path filter, and 2 image-digest map entries (`.github/workflows/ci.yml`).
- 23 commits in the last 90 days; last touched 2026-07-18 (1 day before this plan).
- A live `@control-center/api: workspace:*` dependency from `products/captive-portal/apps/api`.

Deleting it means **decommissioning a running guest-WiFi captive portal and permanently destroying its Postgres database** on the teardown push. The task's scope explicitly lists captive-portal's infra workloads as blast-radius to remove, so the *intent* is decommission — but because a `pulumi up` on the teardown push will delete the CNPG cluster (data loss) and the DNS/certs, this plan gates that work behind an explicit confirmation + data snapshot (Slice C0) and sequences it so it is reversible up to the CNPG delete. **Open Question 1 below must be answered before Slices C1–C3 run.**

By contrast `products/project-management` **is** genuinely dead: never deployed (no Dockerfile, no CI job, no infra), 29 days stale, its "ship to prod" epic (`www-1ck3`) was deferred and never executed, and it is the last remaining Temporal consumer. It is safe to delete outright (Slice 1).

---

## 1. Recommendations summary (do-now / do-later / don't)

| Item | Verdict | Why (short) |
|---|---|---|
| Delete `products/project-management` | **DO NOW** (Slice 1) | Truly dead, zero infra/CI blast radius, removes Temporal + 3 knip config hints. |
| Fix `CODEBASE_OVERVIEW.md` drift (`ccinfra`→`wwwinfra`, worker list, media-worker direction) | **DO NOW** (Slice 0) | Pure doc, zero risk, actively misleading today. |
| Retire `git push --no-verify` habit | **DO NOW** (Slice 0) | The pre-push hook already passes clean — see §2. The habit is folklore. |
| Delete / decommission `products/captive-portal` | **DON'T until Open Q1 confirmed** (Slices C0–C3, hard-gated) | Live guest-WiFi service with its own prod DB. **Out of scope as pure "simplification"** — do not start C1+ until product retirement is independently confirmed. C1's `pulumi up` permanently destroys the CNPG database. |
| Collapse `products/control-center/*` up a level | **DON'T** (see §4) | Cosmetic benefit; fights the documented platform north-star; trips 4 purpose-built guard scripts + platform folder-derivation for near-zero payoff. |
| `packages/api` (1-symbol type bridge) | **KEEP** (see §3) | Shallow by line count, but it is a deliberate browser↔server dependency firewall. Deleting it re-introduces the exact edge it exists to prevent. |
| `packages/logger` | **KEEP** (see §3) | Deep and widely consumed across 5 workspaces. |
| `packages/platform` | **KEEP, simplify** (see §3) | Keep for the platform model; it loses ~half its surface once captive-portal is gone (folded into Slice C2). Revisit folding into `infra/` later — not now. |
| Re-enable export-level knip detection | **DO LATER** (Slice 2, optional) | Temporal was the reason it was disabled; once project-management is gone the reason is gone. Low priority. |

---

## 2. The `git push --no-verify` situation — reproduced

The user memory says *"push still needs `--no-verify` (pre-existing knip fail)."* **This is stale. Reproduced on a clean `main` checkout, the pre-push hook passes.**

The pre-push hook (`lefthook.yml` → `pre-push`, `piped: true`) runs two commands in order, aborting on the first failure:

1. `bun run lint:tracked` → `bunx biome check --no-errors-on-unmatched <git ls-files list>`
2. `bun run knip` → `bunx knip --exclude exports,nsExports,types,nsTypes`

Reproduction (clean tree, `git status` empty):

```
$ bun run lint:tracked   → EXIT=0
$ bun run knip           → EXIT=0   (only 5 non-blocking "Configuration hints")
$ bun run gate:pre-push  → EXIT=0   (runs both, piped, same as lefthook)
```

Knip's 5 "Configuration hints" do **not** set a non-zero exit — knip only fails on actual unused files/deps. Three of those five hints are redundant `products/project-management` entry patterns that vanish the moment Slice 1 lands.

**Root cause of the folklore:** the `--no-verify` habit dates to the 2026-07-11 bd removal, when there was a transient knip failure; it has since been fixed and the habit outlived the failure. The `knip-deadcode` comment in `lefthook.yml` still says *"Export-level detection is disabled inside `bun run knip` because Temporal registers workflow/activity exports dynamically by name"* — that rationale dies with project-management too.

**The fix is behavioral + hygiene, not a code change:**
- Stop passing `--no-verify`. Pushes go through the hook.
- (Slice 1) Deleting project-management clears the 3 project-management knip hints.
- (Slice 2, optional) Once Temporal is gone, the `--exclude exports,nsExports,types,nsTypes` flags and the two remaining hints (`**/ios/DerivedData/**`, `@capacitor/core`) can be reconsidered; re-enabling export detection would *widen* dead-code coverage, but validate it doesn't flood on legitimate dynamic exports before committing.

If a future push *does* trip the hook, it will be a real lint or dead-code regression that CI would reject anyway — which is the whole point of the hook. **Do not reach for `--no-verify`; fix forward.**

---

## 3. Shared package verdicts (deletion test applied)

**`packages/api` — KEEP.** Interface: exactly one exported symbol, `export type { AppRouter }`, re-exported through `.` and `./trpc`. Implementation: 4 lines, no tests. By line count it is the definition of a shallow module. **But depth here is the wrong lens — it is a *seam*, not a complexity-hider.** Its job (per `CODEBASE_OVERVIEW.md`) is to give `web` a typed tRPC client *without* taking a workspace dependency edge onto backend runtime code. Deletion test: delete it, and `web`'s 3 type-only import sites (`lib/trpc.ts`, `lib/log/ship.ts`, `lib/log/trpc-link.ts`) must import `@control-center/api/trpc` directly — re-creating the browser→backend workspace edge the package exists to forbid, and the App-construct FINAL design explicitly routes `AppRouter` through this package byte-for-byte. One adapter today, but it is a real firewall. **Keep.** (This is the "one adapter is hypothetical" caveat overridden by an explicit invariant: the seam is load-bearing even with a single consumer.)

**`packages/logger` — KEEP.** Interface: 4 symbols (`Logger`, `CreateLoggerOptions`, `createLogger`, `getLogger`). Implementation: 166 LOC of redaction/config behind them, plus a 307-line redaction test. Consumed by 5 distinct workspaces (api, worker, media-worker, captive-portal/apps/api, worker-runtime). Deletion test: logger setup + redaction config would reappear, independently and divergently, in each of those 5 workspaces. Genuinely deep, genuinely shared. **Keep.** (Note: the captive-portal/apps/api consumer disappears with Slice C3 — still 4 workspaces, still a keep.)

**`packages/platform` — KEEP, simplify.** Interface: 49 exports; implementation: 828 LOC + ~470 test LOC. **But its entire real consumer surface is `infra/` (both Pulumi projects) plus three root repo-shape guard scripts — zero product runtime imports it.** Structurally it is an infra-internal module wearing a shared-package coat. Two forces keep it a package *for now*: (a) it is the M1 foundation of the documented platform north-star, and (b) folding 828 LOC into `infra/` is itself a refactor with its own blast radius. **Verdict: keep, but shrink it in Slice C2** (removing captive-portal deletes `captivePortalProductManifest`, `captivePortalWeb`, the captive-portal `secretCatalog` branch, and collapses `productSlugs` to a single-element tuple). **Do-later:** once captive-portal is gone and if the platform north-star is ever abandoned, reconsider folding platform into `infra/` — not part of this plan.

---

## 4. `products/control-center/*` collapse — cost/benefit → DON'T (now)

**The idea:** flatten the extra nesting so e.g. `products/control-center/web` moves up a level.

**The cost (recon-verified tripwires that fire on any such relocation):**

- **4 purpose-built guard scripts** exist specifically to assert these path literals stay put, and would each need rewriting: `scripts/check-control-center-ci-split.ts` (greps `ci.yml` filter blocks + control-center image-name lists), `scripts/check-control-center-product-boundary.ts` (`productRoot` const, workspace-glob + manifest assertions, self-nesting guard), `scripts/check-dockerfile-manifests.ts` (hardcoded Dockerfile path list), `scripts/check-tilt-product-lanes.ts` (Tiltfile path + lane-label assertions).
- **Every path literal:** `package.json` workspaces glob `products/control-center/*`; `biome.json` (lines 59–86); `tsconfig.config.json:11`; `vitest.config.ts:8–14,38–39`; **all 4 product Dockerfiles' per-workspace `COPY` line sets** (~13 lines each); `products/control-center/product.json`; the `@control-center/api` import-path literals in `worker-deps.ts`, `media.ts`, and both worker entrypoints; the CI `web/api/worker/mediaworker/storybook/drizzle/mapprovision` path filters and the deploy-job digest map.
- **`packages/platform` derives `folder: products/${slug}`** from the bare slug — the derivation itself survives a move (it doesn't stat the filesystem), but every hardcoded `products/control-center/...` string above does not.

**The benefit:** cosmetic — one less directory level. Nothing is untestable, unnavigable, or slow because of the nesting.

**The direction it fights:** `CODEBASE_OVERVIEW.md` §"Platform Migration" and `docs/platform/NORTH_STAR.html` document the repo *deliberately* moving toward `products/<name>` product boundaries, with `products/control-center` introduced as the M7 boundary. Collapsing it back up a level is a direct reversal of the documented target.

**Recommendation: DON'T.** The collapse trips four guards that were written *to hold this exact shape*, touches dozens of path literals across CI/Docker/infra/scripts, and buys only a cosmetic level — while reversing the stated platform direction. **Do-later only if** the team formally abandons the platform north-star; at that point revisit as its own dedicated plan (it is not "simplification", it is a re-architecture with equal-or-greater churn than what it removes).

---

## 5. Slices

Each slice: **Goal → Files → Steps → Verification → Rollback.** Slices 0–2 are independent and can ship in any order. Slices C0–C3 are ordered and gated on Open Question 1.

### Slice 0 — Fix `CODEBASE_OVERVIEW.md` drift (pure doc, zero risk)

**Goal:** Stop the overview from actively lying about the Pulumi namespace, the worker roster, and the media-worker direction.

**Files:**
- Modify: `CODEBASE_OVERVIEW.md`

- [ ] **Step 1:** Replace the two `ccinfra:` occurrences (the "Deployment" section, ~line 183, `must be namespaced as ccinfra:imageDigests.<svc>`) with `wwwinfra:`. Verified against `infra/program.ts:19` (`new pulumi.Config("wwwinfra")`) and `.github/workflows/ci.yml` deploy step (`wwwinfra:imageDigests.*`, `wwwinfra:kubeContext`).
- [ ] **Step 2:** In the "Workers" section (~lines 126–135), add the two missing registered workers: `github-actions-poll` (10s tick, self-gated to ~1 real poll/60s, powers the Deploys tile) and `notify-queue` (2s, claims only `notify` jobs). Both exist in `products/control-center/worker/src/index.ts` but are absent from the doc list.
- [ ] **Step 3:** In the media-worker sections (~lines 143–148 and the runtime diagram lines 21–29), add a one-line note that the media-worker is slated to fold into `worker` per the current re-architecture, and remove/soften any language implying media-worker is a permanent separate deployable. Do **not** delete the media-worker description yet — the fold is a separate plan; this only corrects direction.
- [ ] **Step 4: Verify** `git grep -n ccinfra CODEBASE_OVERVIEW.md` returns nothing; the worker list contains `github-actions-poll` and `notify-queue`.
- [ ] **Step 5: Commit + push** (through the hook, no `--no-verify`):

```bash
git add CODEBASE_OVERVIEW.md
git commit -m "docs: fix wwwinfra namespace, worker roster, media-worker direction in overview"
git push
```

**Verification:** CI green (doc-only change triggers no build/deploy; the `test` job's `check-product-doc-paths` guard still passes because no product doc path was removed).

**Rollback:** `git revert <sha> && git push`.

---

### Slice 1 — Delete `products/project-management` (dead product)

**Goal:** Remove the never-shipped Temporal product and every config reference to it.

> **CRITICAL — this slice DOES trigger image builds.** Deleting the folder + `bun install` drops `products/project-management` from `bun.lock`. `bun.lock` is in the `web`, `api`, `worker`, `mediaworker`, `storybook`, and `captiveportal` CI path filters (`.github/workflows/ci.yml:76,81,89,97,113,132`), so this push **forces all those image builds**. All 7 full-install Dockerfiles still hard-`COPY products/project-management/package.json` — a file this commit deletes — so each build dies at the `COPY` step unless those lines are removed **in the same commit**. `scripts/check-dockerfile-manifests.ts` will NOT catch this: it only flags *missing* workspace manifests, never *stale extra* COPYs of a deleted path — the failure surfaces only in the build jobs, which is why it is easy to miss.

**Files:**
- Delete: `products/project-management/` (entire tree)
- Modify: **all 7 full-install Dockerfiles** — remove the `COPY products/project-management/package.json …` line from each:
  `products/control-center/{api,web,worker,media-worker}/Dockerfile`,
  `products/control-center/web/Dockerfile.storybook`,
  `products/captive-portal/Dockerfile.api`,
  `products/captive-portal/apps/frontend/Dockerfile`.
  (Verified line refs: api:25, media-worker:25, worker:26, web:24, Dockerfile.storybook:13, captive-portal/Dockerfile.api:29, captive-portal/apps/frontend/Dockerfile:28.)
- Modify: `vitest.config.ts` (remove line 14 project entry `"products/project-management"`)
- Modify: `knip.jsonc` (remove the `products/project-management` workspace block and its 2 `ignore` entries `public/_ds`, `public/support.js`; the 3 "redundant entry pattern" hints disappear with the folder)
- Modify: `biome.json` (remove line 60 `!**/products/project-management/public` and line 86 `**/products/project-management/server.ts`)
- Modify: `README.md` (remove line 14 product-table row for project-management)
- (Optional, low priority) Modify: `.opencode/agent/ticket-mergefix.md`, `.opencode/skills/writing-tickets/SKILL.md` — agent tooling that references project-management workflows; leave unless they break tooling. Note only.

**Steps:**
- [ ] **Step 1:** `git rm -r products/project-management`.
- [ ] **Step 2:** Remove the `COPY products/project-management/package.json …` line from **all 7 Dockerfiles** listed above (grep to confirm zero remain: `git grep -n "products/project-management/package.json" -- '*Dockerfile*'` returns nothing).
- [ ] **Step 3:** Edit `vitest.config.ts`, `knip.jsonc`, `biome.json`, `README.md` per the file list above.
- [ ] **Step 4:** `bun install` (workspaces resolve without the folder; the `products/*` glob simply stops matching it; `bun.lock` loses the `products/project-management` key).
- [ ] **Step 5: Verify** the guard scripts and gates:

```bash
bun run typecheck        # expect PASS
bun run test             # expect PASS (vitest no longer lists project-management project)
bun run lint             # expect PASS
bun run knip             # expect EXIT 0, and the 3 project-management hints GONE
bun run test:dockerfile-manifests   # expect PASS (still green — the guard only checks for
                                     # MISSING manifests; the deleted COPY lines must be
                                     # verified by the git grep in Step 2, not by this guard)
bun run test:product-workspaces && bun run test:product-doc-paths   # expect PASS
git grep -n "products/project-management/package.json" -- '*Dockerfile*'   # expect NO output
```

If `check-product-doc-paths` or `check-product-workspaces` asserts a project-management path exists, update that assertion in this same commit (project-management is not a platform product, so this is unlikely, but the run above will surface it).

- [ ] **Step 6: Commit + push:**

```bash
git add -A
git commit -m "chore: delete unused project-management product (Temporal, never shipped)"
git push
```

**Verification:** CI green. **This push DOES rebuild the control-center + storybook + captive-portal images** (the `bun.lock` change triggers those filters); they build clean *because* the project-management COPY lines were removed in Step 2. If the COPY lines are left in, every one of those builds fails at the `COPY` step. `bun run knip` output is now down to 2 hints.

**Rollback:** `git revert <sha> && git push`. (Pure source/config deletion — fully reversible, no infra state involved.)

---

### Slice 2 — (Optional) knip hygiene now that Temporal is gone

**Goal:** Clean the two remaining knip config hints and, optionally, widen dead-code detection.

**Files:**
- Modify: `knip.jsonc` (address `**/ios/DerivedData/**` ignore and `@capacitor/core` ignoreDependencies hints)
- Modify (only if re-enabling export detection): `scripts/quality-gate.ts` (the `knip` and `pre-push` gate `--exclude exports,nsExports,types,nsTypes` args) and `lefthook.yml` (update the `knip-deadcode` comment that cites Temporal)

**Steps:**
- [ ] **Step 1:** Apply the two safe knip.jsonc hint fixes; re-run `bun run knip`, expect 0 hints.
- [ ] **Step 2 (guarded):** *Only if* widening detection — remove `exports,nsExports` (and/or `types,nsTypes`) from the exclude list in `scripts/quality-gate.ts`, run `bun run knip`, and **inspect for false positives on legitimately-dynamic exports before keeping the change.** If it floods, revert the exclude removal — the hint cleanup alone is still worth shipping.
- [ ] **Step 3: Verify** `bun run gate:pre-push` EXIT 0.
- [ ] **Step 4: Commit + push** `chore: knip hygiene after Temporal removal`.

**Verification:** CI `typecheck` job (which runs knip) green.

**Rollback:** `git revert <sha> && git push`.

---

### Slice C0 — DECISION GATE + captive-portal data snapshot (ops, NO code push)

> **BLOCKS C1–C3.** Do not proceed until Open Question 1 is answered "yes, decommission."

**Goal:** Confirm intent and make the destructive teardown reversible up to the CNPG delete.

**Steps (no commit — these are ops actions recorded in the slice):**
- [ ] **Step 1:** Get explicit confirmation that the guest-WiFi captive portal is being **decommissioned** (traffic drained / no longer needed). Record who/when.
- [ ] **Step 2:** Snapshot the captive-portal Postgres database using the existing tool, to a retained location (NOT a scratch target):

```bash
# captive-portal has its own CNPG cluster; dump it before teardown.
# Use scripts/pg-snapshot-restore.sh in dump mode against the captive-portal DB,
# or kubectl exec into the captive-portal-rw pod and pg_dump -Fc.
kubectl --context cc-homelab -n captive-portal get cluster,pods
# then a custom-format dump to the NAS-backed path used by captive-portal-pg-backup
```

- [ ] **Step 3:** Capture current DNS + cert state for `captive-portal.worldwidewebb.co` and `app--cp.worldwidewebb.co` (Cloudflare records, cert-manager Certificate objects) so they can be re-created if the decommission is reversed.
- [ ] **Step 4:** Confirm nothing else in prod depends on the captive-portal namespace (the control-center `portal` tRPC router + `portalRouter`/portal schema in `products/control-center/api` are a **separate** concern and stay — they are not part of `products/captive-portal`).

**Verification:** A retained, restorable DB dump exists and has a non-zero row count; confirmation recorded.

**Rollback:** N/A (no push). This slice *is* the rollback safety net for C1.

---

### Slice C1 — Tear down captive-portal infra **+ its CI deploy plumbing** (the destructive push)

**Goal:** Remove captive-portal from the Pulumi program so `pulumi up` deletes its workloads, cert, DNS, backup cron, and CNPG cluster — **and, in the same commit, stop CI from injecting captive-portal image digests.** **This push deletes prod resources and the CNPG database** (snapshotted in C0).

> **WHY the CI digest map moves here (was C3) — this is load-bearing.** The deploy job builds `wwwinfra:imageDigests` from a **hardcoded, un-path-filtered list** (`.github/workflows/ci.yml:558`) that includes `www-captive-portal-portal:captive-portal-portal` and `www-captive-portal-api:captive-portal-api`, then runs `pulumi config set --path wwwinfra:imageDigests.captive-portal-portal <sha>` (`ci.yml:650-653`). The infra program calls `validateImageDigests` **unconditionally** (`infra/src/services.ts:220`), which throws `imageDigests.captive-portal-portal is not a known product-component image key` (`services.ts:83-85`) for any key not in `IMAGE_REPOSITORIES`. So if C1 removes captive-portal from `IMAGE_REPOSITORIES` **but leaves the ci.yml digest entries**, the very next `pulumi up` — this push's own deploy, and *any* later deploy including a `packages/platform` change via `any_app` — hard-fails. **The infra `IMAGE_REPOSITORIES` removal and the ci.yml digest-map/build-job removal MUST land in one commit.** Note: `pulumi preview` run locally cannot catch this — `Pulumi.prod.yaml:7` pins `wwwinfra:imageDigests: {}` and the captive-portal keys exist only in CI, so a local preview is falsely green.

**Files (remove captive-portal references; keep the file, delete its captive-portal branches):**

*Infra (Pulumi):*
- Modify: `infra/src/services.ts` (remove `captive-portal-portal` + `captive-portal-api` workloads, their `IMAGE_REPOSITORIES` entries, secret mounts)
- Modify: `infra/src/cnpg.ts` (remove the captive-portal CNPG cluster)
- Modify: `infra/src/certmanager.ts` (remove captive-portal + app--cp certs)
- Modify: `infra/src/crons.ts` (remove `captive-portal-pg-backup`)
- Modify: `infra/src/secrets-map.ts`, `infra/src/ghcr-pull-secrets.ts` (remove captive-portal secret/pull-secret mappings)
- Modify: `infra/cloudflare/src/routes.ts`, `infra/cloudflare/src/access.ts` (remove captive-portal DNS/Access)
- Modify: `infra/program.ts` (remove captive-portal exports: cnpg cluster name, cert name, etc.)
- Modify: the affected `infra/test/*.test.ts` and `infra/cloudflare/test/*.test.ts` (namespaces-components, image-digests, eso, cnpg-certmanager, render, ghcr-pull-secrets, crons, secrets-derivation, cloudflare routes/access) — update expectations in the SAME commit so `bun run test` stays green.

*CI deploy plumbing (moved here from the old C3 to keep the deploy green):*
- Modify: `.github/workflows/ci.yml` — remove the two `www-captive-portal-*:captive-portal-*` entries from the deploy-job image-digest `for entry` list (`:558`); remove the `build-captive-portal` + `build-captive-portal-api` jobs; remove `build-captive-portal, build-captive-portal-api` from **every** `needs:` list (`:467`, `:664`). **Do NOT yet remove** the `captiveportal` path filter, the storybook/`any_app` `products/captive-portal/**` entries, or the Dockerfiles here — those still reference the folder, which is not deleted until C3. Removing the build jobs + digest entries is sufficient and necessary to keep `pulumi up` green; the path filters are harmless until the folder goes.
- Modify: `scripts/check-product-ci-isolation.ts` **only if** it asserts the *build jobs* exist. If it asserts the `captiveportal` *path filter* exists (which C1 leaves in place), leave that guard alone until C3. Run `bun run test:product-ci-isolation` to see which; update whatever the ci.yml edit actually breaks, in this same commit.

> Note: `infra/src/services.ts` still imports `captivePortalProductManifest` from `packages/platform`; that platform symbol is removed in C2. Order matters — C1 removes the *infra usages*, C2 removes the *platform definitions*. Between C1 and C2, platform still exports the (now-unused) captive-portal manifest; knip may flag it as unused, so **C1 and C2 can be combined into one commit if knip complains** about the orphaned platform export. Prefer two commits; fall back to one if the gate forces it.

**Steps:**
- [ ] **Step 1:** Remove captive-portal from each infra file above.
- [ ] **Step 2:** Remove the captive-portal build jobs + digest-map entries + `needs:` references from `ci.yml`; update `check-product-ci-isolation.ts` only for whatever the ci.yml edit breaks.
- [ ] **Step 3:** Update the infra test expectations in the same edit.
- [ ] **Step 4: Verify locally:**

```bash
bun run typecheck && bun run test          # expect PASS
bun run test:product-ci-isolation          # expect PASS (guard matches the ci.yml edit)
cd infra && pulumi preview --stack prod    # REVIEW: expect DELETE of captive-portal
                                           # workloads, cert, cnpg cluster, cron, DNS —
                                           # and NOTHING else deleted.
```

**Read the `pulumi preview` diff carefully — confirm the only deletions are captive-portal resources.** If anything control-center is marked for delete, stop and fix. Remember the preview is blind to the CI-injected digests (see WHY box) — the real guarantee is that the ci.yml digest entries are gone in this same commit.

- [ ] **Step 5: Commit + push.** CI runs `pulumi up --stack prod`, which performs the teardown. Because the ci.yml digest entries are gone in this commit, no unknown `imageDigests` key reaches `validateImageDigests`.

```bash
git commit -am "infra+ci: decommission captive-portal (workloads, cnpg, cert, dns, backup cron, deploy digests)"
git push
```

**Verification:** `pulumi up` succeeds; `kubectl -n captive-portal get all` shows the namespace draining/gone; control-center unaffected (`kubectl -n control-center get pods` healthy).

**Rollback (up to the CNPG delete):** `git revert <sha> && git push` re-creates the workloads/cert/DNS **and** restores the ci.yml digest entries/build jobs together (they are one commit, so the revert is self-consistent and its own `pulumi up` is green); the CNPG database is restored from the C0 snapshot into a fresh cluster. **Past the successful `pulumi up`, the old database is gone** — this is why C0 is mandatory. **Do not revert C1 after C2/C3 have landed** — see the "Coupled-chain rollback" note at the end of §5.

---

### Slice C2 — Remove captive-portal from `packages/platform`

**Goal:** Delete the platform product definitions for captive-portal now that no infra consumes them.

**Files:**
- Modify: `packages/platform/src/index.ts` — remove `captivePortalProductManifest`, `captivePortalWeb`, the `captive-portal` `secretCatalog` branch, the captive-portal `defineProduct` usages, and collapse `productSlugs` from `["control-center", "captive-portal"]` to `["control-center"]` (and the derived `ProductSlug` union).
- Delete: `packages/platform/test/captive-portal-manifest.test.ts`
- Modify: `packages/platform/test/{identity,secrets,exposure,database,backup,product-boundary,control-center-manifest}.test.ts` — remove captive-portal cases/assertions in the same commit.
- Modify: `scripts/check-product-workspaces.ts`, `scripts/check-product-doc-paths.ts`, `scripts/check-tilt-product-lanes.ts` if they iterate `productSlugs` and assert a captive-portal entry.

**Steps:**
- [ ] **Step 1:** Remove the captive-portal exports and shrink `productSlugs`.
- [ ] **Step 2:** Update/delete the platform tests and any guard script that enumerates `productSlugs`.
- [ ] **Step 3: Verify:** `bun run typecheck && bun run test && bun run knip` — expect PASS with no orphaned captive-portal export flagged.
- [ ] **Step 4: Commit + push** `refactor(platform): drop captive-portal product definitions`.

**Verification:** CI green; `infra` still typechecks (it no longer imports the removed symbols after C1).

**Rollback:** `git revert <sha> && git push`.

---

### Slice C3 — Delete the `products/captive-portal` folder + all remaining plumbing (ONE atomic commit)

**Goal:** Remove the source tree, its Dockerfile COPY lines, the storybook composition, the guards that assert it exists, and the last root-config references — **all in a single commit.** (This merges the former C3 "CI/Dockerfile/guards" slice with the former C4 "folder + root config" slice.)

> **WHY this MUST be one commit — the frozen-lockfile/manifest-guard trap.** There is **no green intermediate ordering** for the folder delete vs. the Dockerfile COPY-line removal:
> - Remove the captive-portal `COPY` lines from the control-center Dockerfiles **first** (folder still present) → `scripts/check-dockerfile-manifests.ts` derives its required manifest set from `bun.lock`'s `workspaces` keys (`:26-33`); captive-portal is still a workspace, so the just-un-COPY'd manifests read as **MISSING** → `exitCode 1` (`:86-89`). Guard FAILS. And the CC image builds (triggered by the `products/control-center/**` Dockerfile edits) run `bun install --frozen-lockfile` against a context missing a member still listed in the lockfile → build fails.
> - Delete the folder + `bun install` **first** (removing captive-portal from `bun.lock`) while leaving the `COPY products/captive-portal/.../package.json` lines → the guard passes (it only checks *missing*, not *stale extra*), but the actual `docker build` dies at the `COPY` step because the file no longer exists.
>
> The only green path is: **folder delete + Dockerfile COPY-line removal + `check-dockerfile-manifests.ts` list update + `bun install` all in the same commit.** Do not split them.

**Files (all in one commit):**
- Delete: `products/captive-portal/` (entire tree — removes the `@control-center/api: workspace:*` consumer)
- Modify: all 4 control-center Dockerfiles (`products/control-center/{web,api,worker,media-worker}/Dockerfile`) — remove the `COPY products/captive-portal/.../package.json` lines.
- Modify: `scripts/check-dockerfile-manifests.ts` — remove `products/captive-portal/Dockerfile.api` and `products/captive-portal/apps/frontend/Dockerfile` from `FULL_INSTALL_DOCKERFILES` (`:47-60`). (After the folder delete these Dockerfiles no longer exist; the guard would otherwise `WARN`-skip them, but remove them cleanly.)
- Modify: `products/control-center/web/Dockerfile.storybook` — remove the captive-portal `COPY` + the `bun run --cwd products/captive-portal/apps/frontend build-storybook` composition step and the `/captive-portal` ref.
- Modify: `products/control-center/web/.storybook/main.ts` — remove the captive-portal storybook reference.
- Modify: `.github/workflows/ci.yml` — now that the folder is gone, remove the residual `captiveportal` path filter, the `products/captive-portal/**` entry from the `storybook` filter and from `any_app`. (The build jobs + digest entries were already removed in C1.)
- Modify: `scripts/check-product-ci-isolation.ts` — remove the `captiveportal`-filter assertion if C1 did not already (it should have left the filter in place; now it goes).
- Modify: `scripts/check-control-center-product-boundary.ts` — remove any captive-portal assertions.
- Modify: `lefthook.yml` — remove the `portal-nginx` pre-commit guard (its glob only matches `products/captive-portal/apps/frontend/*.conf`).
- Modify: `products/control-center/api/src/trpc/init.ts` — inspect the captive-portal grep hit; only remove if it is a captive-portal-product reference and not the control-center `portal` router (which stays).
- Modify: `vitest.config.ts` — remove lines 12–13 (`products/captive-portal/apps/api`, `products/captive-portal/apps/frontend`); the coverage `include` glob `products/*/apps/*/src/**` stays as a generic glob (fine).
- Modify: `biome.json` — remove lines 59, 71–72 (`!**/docs/captive-portal/design`, the two captive-portal playwright includes)
- Modify: `knip.jsonc` — remove any captive-portal workspace block
- Modify: `README.md` — remove captive-portal product-table rows
- Modify: `CODEBASE_OVERVIEW.md` §"Workspace Layout" — drop the two captive-portal lines and the M7 delegation prose that mentions captive-portal.
- Optional: `docs/captive-portal/**` design docs — leave (archive) or delete per preference; not load-bearing.

**Steps:**
- [ ] **Step 1:** `git rm -r products/captive-portal`.
- [ ] **Step 2:** Remove the captive-portal `COPY` lines from the 4 CC Dockerfiles and the storybook Dockerfile; remove the storybook compose step + `main.ts` ref.
- [ ] **Step 3:** Update `scripts/check-dockerfile-manifests.ts`, `check-product-ci-isolation.ts`, `check-control-center-product-boundary.ts`, `lefthook.yml`, `ci.yml`, `init.ts` per the file list.
- [ ] **Step 4:** Edit root config: `vitest.config.ts`, `biome.json`, `knip.jsonc`, `README.md`, `CODEBASE_OVERVIEW.md`.
- [ ] **Step 5:** `bun install` (removes the captive-portal workspaces from `bun.lock`; confirm `@control-center/api` still resolves for its remaining consumers).
- [ ] **Step 6: Verify** (the guard + build pair must go green **together**):

```bash
bun run typecheck && bun run test && bun run lint && bun run knip   # all PASS
bun run test:dockerfile-manifests          # expect PASS — captive-portal is now
                                            # BOTH out of bun.lock AND out of the guard list
                                            # AND out of the CC Dockerfiles (atomic)
bun run test:product-ci-isolation          # expect PASS
bun run check:control-center-product-boundary
bun run gate:pre-push                       # EXIT 0
git grep -il captive-portal -- ':!docs' ':!node_modules'   # nothing outside kept archive docs
```

- [ ] **Step 7: Commit + push** `chore: delete captive-portal product source, Dockerfiles, guards, workspace entries`.

**Verification:** CI green; the CC + storybook images rebuild clean (bun.lock changed) *because* the captive-portal COPY lines and workspace members were removed together; storybook image still builds (control-center-only).

**Rollback:** `git revert <sha> && git push` restores the source *code*; note the *service* is already gone (C1) — reversing C3 alone only restores code, not the running product, and does not re-create the CNPG database.

---

### Coupled-chain rollback (C1 → C3) — read before reverting any captive-portal slice

The uniform per-slice `git revert <sha>` is **only sound while the slice is the branch tip.** C1–C3 are a coupled chain:

- **Reverting C1 after C2/C3 have landed produces a red deploy.** C1's revert reintroduces infra workloads whose `REQUIRED_IMAGE_DIGEST_KEYS` demand captive-portal digest pins (`infra/src/services.ts:77-79,89-98`), but C1's revert also restores the ci.yml build jobs/digest entries — so *that* part is consistent. The real hazard is C3-then-revert-C1: C3 deletes the folder, so the restored build jobs have no Dockerfile/source to build → the digests are never produced → `validateRequiredImageDigests` throws `missing: captive-portal-portal`. **To roll the whole decommission back, revert in reverse order (C3, then C2, then C1) as a group**, or forward-fix. Do not `git revert` a single mid-chain slice in isolation.
- Past C1's successful `pulumi up`, the CNPG **database is permanently gone** regardless of any code revert — only the C0 snapshot restores it.

---

## 6. CODEBASE_OVERVIEW.md — full list of stale claims to fix

Tracked across Slice 0 (drift) and Slice C3 (product removal):

- **`ccinfra` → `wwwinfra`** (Deployment section). Code truth: `infra/program.ts:19`, `.github/workflows/ci.yml` deploy step.
- **Worker roster** missing `github-actions-poll` and `notify-queue` (add both).
- **media-worker** described as a permanent separate deployable — reframe as folding into `worker` per the user decision.
- **Workspace Layout / Platform Migration** sections list `products/captive-portal/apps/*` and describe the two-product platform split — remove captive-portal lines after Slice C3; `packages/platform` prose should say it now expresses a single product.
- **`packages/api`** prose is accurate (keep); optionally add the one-line "it is a deliberate browser↔server firewall seam, not a complexity-hider" framing.

---

## 7. Self-review

- **Spec coverage:** project-management delete ✓ (Slice 1, incl. its 7 Dockerfile COPY lines); captive-portal delete + all named blast radius — CI build jobs + deploy digest map ✓ (C1, co-committed with infra so the deploy stays green), residual path filters ✓ (C3), Dockerfile COPY lines ✓ (C3, co-committed with folder delete + bun.lock removal), workspaces globs ✓ (C3), infra workloads `captive-portal-portal`/`captive-portal-api` ✓ (C1), guard scripts ✓ (C1 infra tests + ci-isolation, C3 dockerfile-manifests/boundary), platform product defs ✓ (C2); control-center collapse evaluated with justified DON'T ✓ (§4); shared-package verdicts ✓ (§3); `--no-verify` reproduced + fix ✓ (§2); CODEBASE_OVERVIEW updates ✓ (Slice 0, §6). Deployable slices w/ verification + rollback ✓ (coupled-chain rollback caveat documented at end of §5).
- **Placeholder scan:** none — every slice names exact files and exact verification commands.
- **Consistency:** the ordering constraint (C1 removes infra usage before C2 removes platform defs; combine if knip flags the orphan) is stated in both C1 and C2. The control-center `portal` tRPC router is explicitly excluded from captive-portal removal in C0 and C3.

---

## Open Questions

1. **Is `products/captive-portal` really being decommissioned?** Recon shows it is a **live, deployed, actively-committed** guest-WiFi product with its own Postgres cluster, TLS, DNS, backups, and CI. The task scope says delete it, but this is a service teardown with permanent DB loss, not a dead-code cleanup. **C1–C3 must not run until this is confirmed.** If the answer is "not yet / keep it running", Slices 0–2 still ship and the captive-portal work is deferred.
2. **Media-worker fold vs. the infra "Phase-4 bring-up" comments.** The user decided media-worker folds into worker, superseding the infra comments — but those comments (`infra/src/services.ts`, `infra/program.ts`, `Pulumi.prod.yaml: mediaWorkerReplicas: "0"`) still physically exist. This plan only corrects the *docs*; the actual fold + infra-comment removal is the App-construct plan's job. Confirm that the media-worker infra teardown is owned by that plan, not this one.
3. **Re-enable export-level knip detection (Slice 2)?** Temporal was the stated reason it was disabled. Widening detection could catch more dead code but risks false positives on legitimately-dynamic exports elsewhere. Ship the safe hint-cleanup regardless; treat the `--exclude` removal as opt-in pending a clean trial run.
4. **`.opencode/` project-management references** (`ticket-mergefix.md`, `writing-tickets/SKILL.md`) — leave as-is, or clean up as part of Slice 1? They are agent tooling, not build inputs; deferred by default.
5. **`packages/platform` future** — after captive-portal removal it is a single-product, infra-only module. Keep as the platform-north-star foundation (this plan's verdict) or schedule a later fold into `infra/`? Not decided here.

---

## Review log

Adversarial review pass; each fatal/major finding independently re-verified against the repo before action.

- **[FATAL] Slice 1 breaks all image builds — 7 Dockerfiles COPY the deleted `products/project-management/package.json`** — ACCEPTED + FIXED. Verified: all 7 full-install Dockerfiles COPY that path; `bun.lock` has the workspace key so `bun install` retriggers the web/api/worker/mediaworker/storybook/captiveportal filters; `check-dockerfile-manifests.ts` only flags *missing* manifests, never stale extras. Slice 1 now removes the 7 COPY lines in the same commit, corrects the false "no image build changes" claim, and adds a `git grep` verification.
- **[FATAL] C3/C4 sequenced backwards — Dockerfile COPY removal separated from bun.lock workspace removal fails the manifest guard + frozen install** — ACCEPTED + FIXED. Verified `check-dockerfile-manifests.ts:26-33/86-89` derives required manifests from `bun.lock` workspaces. Merged former C3 (non-CI parts) + C4 into a single atomic Slice C3 (folder delete + Dockerfile COPY removal + guard-list update + `bun install` in one commit) with a "WHY this must be one commit" box proving no green intermediate ordering exists.
- **[FATAL] C1/C3 split makes the C1 (and C2) `pulumi up` hard-fail — ci.yml injects captive-portal digests that infra's `validateImageDigests` rejects** — ACCEPTED + FIXED. Verified ci.yml:558 hardcodes the two `www-captive-portal-*` digest entries un-path-filtered; `services.ts:220` calls `validateImageDigests` unconditionally and `:83-85` throws on unknown keys; `Pulumi.prod.yaml:7` pins `imageDigests: {}` so local preview is blind. Moved the ci.yml build-job + digest-map + `needs:` removal into Slice C1 (same commit as the infra `IMAGE_REPOSITORIES` removal), with a "WHY the CI digest map moves here" box.
- **[MAJOR] Uniform per-slice `git revert` is unsound for the coupled C1→C3 chain** — ACCEPTED + FIXED. Added a "Coupled-chain rollback" subsection at the end of §5 and per-slice cross-references: reverting a mid-chain slice in isolation reds the deploy (restored build jobs with no source → `validateRequiredImageDigests` throws `missing`); roll back in reverse order as a group or forward-fix.
- **[MAJOR] Summary-table verdict "DO NOW, but gated" misleads an executor into a prod-DB-destroying slice** — ACCEPTED + FIXED. Changed the captive-portal row to "DON'T until Open Q1 confirmed (hard-gated) / Out of scope as pure simplification", matching Slice C0 and Open Q1.
- **[MAJOR] App-construct Slice 11 media→av tRPC-root rename opens a panel-visible 404 window on the live SPA** — ACCEPTED as valid, OUT OF SCOPE HERE. Verified 21 live `trpc.media.*` call sites in `web`. This finding is about `FINAL-app-construct.md` (a separate design deliverable), not this repo-simplification plan; recorded here so the app-construct plan owner adds a dual-key/transition-alias step. No change to this document.
- **[MAJOR] App-construct Slice 0 packs too much + its git-diff drift guard can red-fail CI** — NOTED, OUT OF SCOPE HERE. Concerns `FINAL-app-construct.md` Slice 0, not this plan. No change to this document; flagged for the app-construct plan owner.
- **[MINOR] Slice 2 knip-widening / packages/platform kept as speculative structure** — REVIEWED, no change. The plan already hedges the knip export-widening as opt-in with a trial-and-revert step (Slice 2 Step 2, Open Q3) and already names the platform "fold into infra/ later" as an explicit deferred item with justification (§3, Open Q5). Both are honest hedges, not scope creep.
