# Don’t Text Your Ex — Restoration Execution Ledger

This file is the durable control-plane record for executing
[`dont-text-your-ex-restoration.md`](./dont-text-your-ex-restoration.md). Update it
whenever a lane commits work, a decision changes, a blocker appears, or production
evidence is collected.

## Locked outcome

- App path: `apps/dont-text-your-ex`
- Recovery source: commit `486a0ebbc`, path `products/text-your-ex`
- Public host: `dont-text-your-ex.worldwidewebb.co`
- Kubernetes namespace: `dont-text-your-ex`
- Preserved Apple bundle ID: `co.worldwidewebb.textyourex`
- Production target: `home-server` Talos cluster, Pulumi stack `home-server`
- Completion threshold: deployed to production and every plan definition-of-done
  item proven with recorded evidence
- Completion notification: publish the final verified result to
  `ntfy.sh/0x63616c` only after all production gates pass

## Tracking

- Software-factory ticket: `T-39`
- Branch: `codex/dont-text-your-ex-restoration`
- Plan-only commit: `b021657b4`
- Raw recovery commit: `c5e81c91c`

## Delegated lanes

| Lane | Plan steps | Owner | State | Last durable result |
|---|---:|---|---|---|
| Application recovery | 1–3 | `app_recovery` | In progress | `79824febc`: workspace/build paths and branding modernized; focused typechecks/build green |
| Production infrastructure | 4–6 | `production_infra` | Locally complete | Four commits through `d24742b83`; infra/Cloudflare/CI tests and lint green; live apply pending |
| Apple and release | 7–9 | `apple_release` | Locally complete | `784b29b49`, `05eb9aadb`; simulator build and release-path validation green; live ASC/device proof pending |
| End-to-end verification | 10 | Unassigned until integration | Pending | Must cover public, cluster, database, Apple, TestFlight, restart, backup, and repeat-deploy evidence |

## Decisions

1. The historical application source is authoritative; current `origin/main`
   infrastructure and repository conventions are authoritative.
2. Keep the conversation’s plan text unchanged. Record current-state adaptations
   and evidence in this ledger.
3. The old `homelab` wording maps to the current `home-server` production target;
   never deploy the retired Pulumi `prod` stack.
4. Use one public host. Route `/` to the frontend and `/api/*` to the API.
5. Preserve Apple identity `co.worldwidewebb.textyourex`; change the displayed
   product name to Don’t Text Your Ex.
6. No secret values may be read or recorded. Presence/key-name checks are allowed.

## Commit and verification log

| Commit | Scope | Checks/evidence |
|---|---|---|
| `b021657b4` | Exact plan document only | Pre-commit secret guards; branch pre-push Biome and Knip gates passed |
| `c5e81c91c` | Raw recovery into `apps/dont-text-your-ex` | Exact source tree recovered from commit `486a0ebbc`; modernization checks pending |
| `79824febc` | Workspace/build modernization and product branding | API typecheck, frontend typecheck, and frontend production build green; DB contract tests discovered and skipped without `DATABASE_URL` |
| `13b5dc054` | Production namespace, CNPG, services, probes, backup, immutable-image CI, and one-host Cloudflare routing | Infra typecheck; infra plus Cloudflare suite 413/413; focused 69/69; build-matrix and deploy-gate guards green |
| `522ce187d` | Cloudflare API path compatibility | Route regex changed to Go RE2-compatible `^/api(/.*)?$`; route tests 12/12 |
| `0926f77f5` | First-deploy GHCR secret bootstrap | Confirmed namespace-NotFound skips preflight without hiding auth/network/missing-secret failures; focused tests 6/6 |
| `784b29b49` | Apple authentication, native app, signing guards, and TestFlight CI | Typecheck/build/Capacitor sync; Xcode 26.2 unsigned simulator `BUILD SUCCEEDED`; Fastfile and workflow parse |
| `05eb9aadb` | TestFlight publishing and acceptance runbook | Explicit external Friends/public-link path and production acceptance gates documented |
| `f96026309` | Runtime configuration guardrail alignment | Repository lint gate green; full app exit checks pending |
| `d24742b83` | Infra export cleanup | Removed unused export found by integrated Knip run |
| `791f46407` | Restored design-reference classification | Knip now treats the recovered non-runtime JSX reference bundle as documentation; Knip green with one pre-existing hint |

## Integrated review and acceptance

First integrated local run before review fixes:

- `bun run check`: green (Biome and all workspace/config typechecks).
- Full Vitest: 289 files passed, 4 skipped; 3015 tests passed, 56 skipped.
- The skipped set included 12 Don’t Text Your Ex Postgres tests because no local
  `DATABASE_URL` was supplied; CI coverage for these is a review blocker, not
  accepted evidence.
- `bun run knip`: green with one pre-existing configuration hint.
- `bun run apps:check`: green.
- Dockerfile workspace/frozen-install manifest guard: all 7 images green.
- Don’t Text Your Ex production frontend build: green.

First independent two-axis review blockers:

1. Validate request, response/error, and persisted JSON boundaries with schemas.
2. Replace untyped screen parameters and broad casts with a discriminated route
   model.
3. Remove fabricated camera-roll/evidence behavior from production UI.
4. Add Storybook coverage for shared primitives and major flow states.
5. Run Postgres contract and Playwright E2E tests in CI rather than skipping them.
6. Carry and validate Sign in with Apple nonce/state without substituting missing
   Apple state.
7. Record an explicit architectural exception/supersession for this requested
   independently deployed app in the otherwise single-product repository.

All seven are pre-merge gates. Live production and Apple evidence remains a
separate post-merge completion gate.

## Production evidence checklist

- [ ] PR reviewed and merged to `main`
- [ ] GitHub CI green at immutable merge SHA
- [ ] `home-server` Pulumi deployment green using stack `home-server`
- [ ] Namespace `dont-text-your-ex` healthy
- [ ] Frontend and API readiness/health green
- [ ] CNPG healthy with persistent storage
- [ ] Database migrations applied
- [ ] Database write survives pod restart
- [ ] Backup succeeds and restore evidence is recorded
- [ ] Public HTTPS host resolves with valid TLS
- [ ] `/` serves the production frontend externally
- [ ] `/api/*` reaches the production API externally
- [ ] Sign in with Apple succeeds end to end
- [ ] Authenticated session/account persists in Postgres
- [ ] TestFlight build uploaded to the existing app
- [ ] External TestFlight group/link available
- [ ] Non-team Apple ID installs and exercises core functionality
- [ ] A subsequent deployment succeeds without manual recovery
- [ ] Final verified completion notification sent to `ntfy.sh/0x63616c`

## Baseline before deployment

Captured 2026-08-14 before implementation was merged:

- `dont-text-your-ex` namespace did not exist on the `home-server` cluster.
- `dont-text-your-ex.worldwidewebb.co` already resolved through Cloudflare to
  `172.67.154.130` and `104.21.82.73`.
- Public HTTPS returned Cloudflare `521`, proving the edge name existed but had no
  reachable origin route yet.
- GitHub authentication was available for repository and workflow operations; no
  pull request existed yet for the restoration branch.

## Blockers and user-assisted gates

- Apple sign-in/2FA: user is available; open App Store Connect early and pause at
  the credential or second-factor prompt.
- External TestFlight verification requires a non-development-team Apple ID and a
  physical-device install; record who performed the check without recording an
  email address or other personal data.

## Progress notifications

- 55%: sent to `ntfy.sh/0x63616c` as event `FzZMz6K0N28Y` after the first
  integrated review. It reported local implementation complete, enumerated the
  review-fix categories, and explicitly stated that production had not been
  deployed.
