# Don’t Text Your Ex — Restoration Execution Ledger

This file is the durable control-plane record for executing
[`dont-text-your-ex-restoration.md`](./dont-text-your-ex-restoration.md). Update it
whenever a lane commits work, a decision changes, a blocker appears, or production
evidence is collected.

The expanded product-completion contract is
[`dont-text-your-ex-v1-release.md`](./dont-text-your-ex-v1-release.md). Read and
maintain both documents; infrastructure completion without v1 feature and QA
acceptance is not done.

The v1 document requires feature-by-feature QA. Record the responsible
implementation agent, independent QA agent, expected behavior, automated and
hands-on evidence, defects/fixes, and final result for every capability before
marking it complete.

## Locked outcome

- App path: `apps/dont-text-your-ex`
- Recovery source: commit `486a0ebbc`, path `products/text-your-ex`
- Public host: `dont-text-your-ex.worldwidewebb.co`
- Kubernetes namespace: `dont-text-your-ex`
- Preserved Apple bundle ID: `co.worldwidewebb.textyourex`
- Production target: `home-server` Talos cluster, Pulumi stack `home-server`
- Completion threshold: deployed to production and every plan definition-of-done
  item proven with recorded evidence
- V1 product threshold: every recovered v1 feature is implemented and usable,
  including reporting/evidence flows; design-to-implementation review and basic
  mobile QA must find no unresolved release blockers
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

Review-fix commits:

- `43a32d914`: discriminated, typed navigation routes.
- `ac8c8818e`: removed fabricated camera-roll evidence; reporting is honestly
  note-only.
- `7f2d126da`: Storybook coverage for onboarding/session expiry, reporting, and
  shared primitives; static and interaction builds green.
- `c8560f331`: Sign in with Apple nonce/state bound across native and backend
  validation; six focused tests green.
- `ab3250bfd`: explicit ADR exception for this requested colocated independently
  deployed product.
- `4cc75f8bc` (plus `c3b5af54d`): shared browser-safe schemas, validated JSON
  boundaries, persisted-evidence parsing, and branded critical IDs; API/frontend
  typechecks, boundary tests, lint, and Knip green.
- `7e32c4b0c`: isolated Postgres contract and Playwright browser CI wired into
  deployment gates; local real-Postgres contracts 12/12 green. An initial local
  browser run was 7/10 before three stale assertions were corrected; the final
  local rerun was environment-blocked by uninterruptible macOS esbuild processes,
  so isolated Linux PR CI is the required authority before merge.
- `b28613dde`: removed the decorative iOS status bar from pointer hit-testing;
  genuine pointer navigation through Create now passes in hosted Playwright.
- `28c2dacaa`: restored the recovered Invite completion action and tightened the
  avatar browser assertion.
- `3056f4190`: handles Apple's missing `fullName` without inventing a name and
  removed the unwanted monthly TestFlight schedule.
- `42d203f33` and `9bae5c9fa`: validated and persisted real PNG/JPEG/WebP report
  evidence, added the platform picker and real viewer, and covered it in
  contract, client, Storybook, and browser tests.
- `029aaa694`: preserved branded jar/report identifiers through frontend routes
  and narrowed caught unknown errors without broad casts.
- `caa619db8`: added the durable v1 acceptance contract and required individual
  agent QA evidence for every feature.
- `a7accd733` and `03e4a2dd5`: protected hidden streaks, private ex labels, and
  anonymous reporter identity at raw API boundaries; made streak sharing opt-in
  and migrated existing memberships back to private. Multi-user Postgres/API
  seams passed locally; hosted CI pending.
- `eac6277ee`: rejects self-reporting with a typed `400 cannot_report_self` and
  proves no report row is created.
- `3720d8609`: production invite URL, web/native deep-link hydration, onboarding
  preservation, AASA, Associated Domains entitlement, signing guard, and an
  eleventh Playwright flow. Focused typecheck/seams/discovery green; independent
  feature QA and hosted browser proof pending.

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

## V1 feature-completeness checklist

- [ ] Apple and development authentication
- [ ] First-run profile setup and later profile/avatar editing
- [ ] Create, join, invite to, and leave/close jars
- [ ] Home and activity states for empty and populated accounts
- [ ] Log, confirm, and deny slips
- [ ] Report members anonymously or named
- [ ] Attach, validate, persist, retrieve, and render real screenshot evidence
- [ ] Enforce note-or-image reporting invariant
- [ ] View report/evidence threads and resolve report outcomes
- [ ] Settle/close the jar lifecycle
- [ ] Persist and revoke sessions/logout correctly
- [ ] Authorization and jar/user isolation
- [ ] Loading, error, validation, and empty states
- [ ] Basic mobile pointer, layout, accessibility, and navigation QA
- [ ] Recovered design vs implementation audit has no unresolved v1 blocker

## Feature-by-feature QA ledger

Initial independent audit was performed against `9bae5c9fa` by
`fix_pr_browser_ci/independent_v1_audit`. `fix_pr_browser_ci` owns the independent
reconciliation pass. A broad hosted happy-path suite is useful evidence but does
not change a row to pass without its feature-specific states and privacy
boundaries being exercised.

| Feature | Implementation owner | Independent QA | Automated/hands-on evidence | Defects or missing states | Result |
|---|---|---|---|---|---|
| Apple auth, onboarding, profile | `apple_release`, `fix_ci_apple_arch` | v1 audit agents | Apple verifier/unit seams; onboarding/profile browser paths; unsigned simulator build | Physical Apple success/cancel/reload/cellular pending; avatar boundary validation, profile failures, and notification preferences incomplete | Blocked |
| Create, join, invite, deep links | recovery/frontend agents + root | v1 audit agents | Create → Invite → Jar pointer path green; `3720d8609` adds canonical URL, onboarding-preserved web path, Capacitor cold/warm plumbing, AASA and 11th browser flow | Independent QA/hosted flow and physical universal-link proof pending; invite expiry/revocation still missing | Blocked |
| Home, jar detail, activity, streak privacy | recovery/frontend agents | v1 audit agents | Home/order/activity browser paths; multi-user raw API seam now omits hidden days and retains self view; new/existing memberships private | Hosted privacy contract pending; fetch failures look empty or load forever | Blocked — privacy fixed, failure states remain |
| Self-log slip | recovery/frontend agents | v1 audit agents | Amount/confirm/tally/pot/streak browser flow; other-member raw JSON now omits private ex label | Hosted privacy contract plus mutation/offline/duplicate/mobile states pending | Blocked — privacy fixed, failure states remain |
| Reports, anonymity, real images, evidence, own/deny | reporting agents | v1 audit agents | Real PNG path, evidence contracts/Postgres round trip, Own/Deny; raw anonymous activity now has `by:null`; self-report rejected with zero persistence | Hosted boundary proof, resolved history, viewer accessibility and image/deny/authorization states missing | Blocked |
| Settle and close lifecycle | recovery/frontend agents | v1 audit agents | Inert payment/owed amount browser path | Failed fetch renders a false `$0`; close/leave semantics and implementation absent | Blocked |
| Sessions and logout | auth agents | v1 audit agents | Store session creation/deletion contracts | Transient `/me` error clears credentials; logout can leave server session; expiry/rotation/reload/revoke states missing | Blocked |
| Loading, error, validation, empty | feature owners | v1 audit agents | Happy-path and selected empty/validation coverage only | Multiple screens swallow fetch/mutation failures or render false empty/success state | Blocked |
| Mobile accessibility and clickability | frontend agents | v1 audit agents | Create overlay regression fixed; iOS simulator build | Missing accessible names/dialog focus/Escape; mobile viewport, VoiceOver, rotation, dynamic type, and physical-device QA pending | Blocked |
| Notifications | Future increment | v1 audit agents | README/migration and v1 scope decision agree | Explicitly excluded from this restoration v1; no silent claim that delivery exists | Not applicable — recorded v1 scope |
| Authorization and data isolation | `fix_ci_apple_arch` follow-up | v1 audit agents | Multi-user Postgres/API seams cover hidden streak, ex label, anonymous reporter, outsider read, opt-in defaults/migration and self-target rejection | Hosted CI and the remaining complete owner/member/accused/outsider action matrix pending | Blocked — confirmed leaks fixed |
| Production and external TestFlight | infra/release agents | external-user acceptance | Container builds and product CI green at `9bae5c9fa`; ASC read-only baseline recorded | Merge/deploy, public/auth, restart, backup/restore, second deploy, signed build, Friends group and non-team install all pending | Blocked |

Every blocked row requires a fixing commit and a fresh evidence entry. This table
must be expanded or split if the audit discovers another independently testable
feature; it is not a waiver for capabilities not listed here.

## Baseline before deployment

Captured 2026-08-14 before implementation was merged:

- `dont-text-your-ex` namespace did not exist on the `home-server` cluster.
- `dont-text-your-ex.worldwidewebb.co` already resolved through Cloudflare to
  `172.67.154.130` and `104.21.82.73`.
- Public HTTPS returned Cloudflare `521`, proving the edge name existed but had no
  reachable origin route yet.
- GitHub authentication was available for repository and workflow operations; no
  pull request existed yet for the restoration branch.

Apple/App Store Connect read-only baseline captured after user sign-in:

- Existing App Store Connect app record: **Text Your Ex**, Apple app id
  `6778544752`, iOS version `1.0`, status `Prepare for Submission`; no build was
  attached to that App Store version.
- TestFlight already contained builds `14` through `23`; build `23` was the newest,
  `Ready to Submit`, assigned only to the internal `Internal` group, with 3
  recorded installs.
- Only the internal TestFlight group was present. No external Friends group or
  public-link group was visible.
- Developer App ID `co.worldwidewebb.textyourex` existed and had **Sign In with
  Apple** enabled as the primary App ID.
- App Store provisioning profile `match AppStore co.worldwidewebb.textyourex`
  existed and was valid through `2027-04-12`.
- This inspection was read-only: no Apple capability, profile, build, group, link,
  or distribution state was changed.

Associated Domains update captured 2026-08-14:

- Enabled and saved **Associated Domains** on App ID
  `co.worldwidewebb.textyourex` for production invite links.
- Regenerated the existing App Store provisioning profile in the Developer
  portal without uploading a build.
- The profile summary still listed only In-App Purchase and Sign In with Apple
  immediately after regeneration. Treat Associated Domains as unproven until the
  signed-build guard reads it from both the embedded profile and app binary.

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
- 70%: sent as event `lkiiKJPjkOJr` after all seven review-fix categories had
  committed changes. It stated that re-review and isolated CI were next and that
  production was not yet deployed.
- 72%: sent as event `JTWgCfQFy016` when the completion goal expanded to include
  every recovered v1 product feature and a full design/basic-QA audit. It noted
  that hosted browser CI was still iterating and production remained pending.
