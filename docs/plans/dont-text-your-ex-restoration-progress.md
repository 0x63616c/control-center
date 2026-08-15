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
| `506dacad0` | Mobile accessibility controls and image-viewer semantics | Named 44px icon/avatar/evidence controls; labelled switches; modal focus, Escape and focus-return interaction; 320px touch/keyboard Playwright coverage; frontend typecheck plus full Biome/Knip push gate green; hosted browser run pending |
| `fe8f93565` | Durable resolved-report history and authorization | Migration-backed report/activity links; active-member list/detail endpoints; real-Postgres owned/denied/evidence/anonymous and accused/member/outsider matrix authored; API typecheck green; hosted database run pending |
| `4a77eb0f6` | Resolved-report history and detail UI | Activity-to-report links; history loading/error/empty/list and detail states; reload browser flow; anonymous evidence Storybook interaction; frontend typecheck and Knip green; hosted browser/Storybook run pending |
| `742834f79` | Atomic jar creation and invite admission | Jar creation now commits the jar/invite and owner membership together; invite joins lock and revalidate the open invite in the same transaction as membership/activity creation. Independent Linux Node 26.7.0 + Postgres 17 execution passed the full store suite 28/28, including forced owner-membership rollback with raw preview/join 404s and controlled close/rotate races with rejected old-code joins |

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
- `72dd17844`: documented and enforced a 30-day absolute session lifetime,
  independent concurrent sessions, lazy expired-session deletion, last-used
  observation without sliding expiry, and current-token-only logout. A migrated
  real-Postgres/Hono seam passed locally; frontend transient-error behavior is a
  separate acceptance gate.
- `456e5b619`: independently hardened the production invite-link boundary,
  native listener lifecycle, strict host/path validation, and safe pre-join
  member summaries. GitHub Actions run `31866340124` is green at this immutable
  SHA: real-Postgres contracts, all 11 Playwright flows, Storybook, typecheck,
  Knip, and both production images.
- `dc422b50b` and `583b06ec1`: validate avatar PNG/JPEG/WebP MIME, signatures,
  and 2 MiB limit at client/server boundaries, plus independent browser QA for
  rejection, save, rendering, and reload persistence. The independent QA commit
  passed the shared-tree pre-push gate and is pushed.
- `7ea259720` and `f8df0df1d`: model loading, true empty, loaded, failed, and
  retry states for Home, Activity, Jar Detail, Settle, and Confirm/Deny without
  false empty, false `$0`, fallback reports, or infinite loaders. The full
  pre-push Biome/Knip gate and frontend typecheck are green; hosted Storybook QA
  is pending.
- `acec8fc8a`: preserve a valid local session through network, HTTP 5xx, and
  boundary failures; clear it only on confirmed 401; require successful server
  revocation before local logout; and provide honest retry UI. Direct/unit seams
  and the full pre-push gate are green; hosted UI/Storybook proof is pending.

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

Split into capability-level rows at `9536caa99`. The latest completed fully green
immutable run is `31866340124` at `456e5b619`, before many of the feature commits
below. Current-head runs `31868412601` and `31868414417` were in progress/queued
during this reconciliation; they are not recorded as green evidence. Superseded
intermediate runs were cancelled and likewise do not prove their feature rows.

| Feature | Implementation owner | Independent QA | Automated/hands-on evidence | Defects or missing states | Result |
|---|---|---|---|---|---|
| Apple authentication | `apple_release`, `fix_ci_apple_arch` | v1 audit agents | `784b29b49` restores native Apple auth/build seams; `c8560f331` binds nonce/state; `3056f4190` handles missing Apple name without invention; `cd4af8715` validates native plugin results | Unit/local simulator seams exist, but current-head hosted proof and physical success/cancel/reload/cellular sign-in are pending | Blocked — hosted, independent, and physical proof pending |
| Development auth and first-run onboarding | auth/frontend agents | v1 audit agents | Development login and profile-setup browser paths exist; `3056f4190` requires a user-entered name when Apple supplies none; `6d63b3c88` validates Storybook fixtures | Hosted current-head flow, independent error/reload QA, and production Apple-backed onboarding remain pending | Blocked — implemented locally; hosted/independent proof pending |
| Profile and avatar editing | `fix_ci_apple_arch` | v1 audit agents | `dc422b50b`/`583b06ec1` enforce image MIME/signature/2 MiB boundaries and cover reject/save/render/reload; `ad939cb77` records regenerated Apple profile state | Local seams/push gate are green; current-head hosted, independent hands-on, physical device, and production persistence proof are pending | Blocked — hosted, independent, physical, and production proof pending |
| Private profile data isolation | `final_spec_review` | `fix_pr_browser_ci` pending | Final spec review found that shared member, activity, and report DTOs reused the private profile schema and exposed every referenced user's `exes`. `925511eaf` splits public users from `/me`, removes ex labels from all shared DTOs, retains the signed-in user's own labels on `/me`, and adds raw authenticated HTTP assertions for jar, activity, pending-report, and report-detail responses. API/frontend typecheck and the focused pre-commit gate passed after the fix | Host Vitest is blocked by the recorded uninterruptible macOS esbuild condition. Fresh Linux Postgres execution of the raw-response test and independent QA are still required | Blocked — defect fixed in code; hosted runtime and independent retest pending |
| Create jar | recovery/frontend agents + `release_spec_rereview` | `backend_release_qa` | Immutable run `31866340124` proves the earlier happy path at `456e5b619`; `f40344ec2` adds offline/retry and duplicate-submit protection. Spec rereview found the jar/invite insert could commit before owner membership and leave a public ownerless orphan. `742834f79` makes both writes atomic and adds a forced membership-failure raw HTTP test proving 500, zero persisted jar/invite rows, and 404 preview/join. Independent Linux Node 26.7.0 + Postgres 17 full store execution passed 28/28 at the fixing commit | Defect fixed and independently retested; current immutable hosted run and production persistence/reload remain pending | Blocked — code/independent Postgres pass; hosted/production proof pending |
| Preview and join jar | recovery/frontend agents + `release_spec_rereview` | `backend_release_qa` | `3720d8609`/`456e5b619` implement strict preview/deep-link join; `f40344ec2` adds invalid code, 403/409/5xx/offline/retry states. Spec rereview found a time-of-check/time-of-use race could admit a member after close or rotation invalidated the code. `742834f79` makes join lock/revalidate the invite and commit membership/activity atomically; controlled raw HTTP close/rotate races prove old-code join 404 and no membership. Independent Linux Node 26.7.0 + Postgres 17 full store execution passed 28/28 at the fixing commit | Defect fixed and independently retested; current immutable hosted run and physical deep-link proof remain pending | Blocked — code/independent Postgres pass; hosted/physical proof pending |
| Invite sharing, expiry, rotation, and deep links | recovery/frontend agents + root | v1 audit agents | `3720d8609`/`456e5b619` add canonical web/native links, AASA, onboarding preservation, and listener boundaries; `f03617886`/`bdec66cee` add seven-day expiry and owner rotation; `463e89e73` fixes seed expiry; `f8718fc02` rejects unverifiable expiry; `ebc5b8c40` preserves reload semantics in E2E | Direct real-Postgres and local UI seams exist. Current-head hosted/independent QA, public Apple CDN AASA, and physical cold/warm iOS links remain pending | Blocked — hosted, independent, and physical proof pending |
| Home states | recovery/frontend agents | v1 audit agents | `7ea259720` plus `e77c5784a`/`ce2bccf34` cover loading, loaded, empty, failure, retry, and fetched-home timing | Current-head hosted Storybook/browser and independent populated/empty mobile visual QA remain pending | Blocked — hosted/independent QA pending |
| Jar detail and streak privacy | recovery/frontend/auth agents | v1 audit agents | `7ea259720` covers fetch/error/retry; `a7accd733`/`03e4a2dd5` hide streaks and make sharing opt-in; raw multi-user seams retain self view | Hosted privacy execution, independent mobile visual QA, and production isolation remain pending | Blocked — hosted/independent/production proof pending |
| Activity states and privacy | recovery/report agents | v1 audit agents | `7ea259720` covers loading/error/empty/retry; anonymous activity redaction and `4a77eb0f6` report links are authored | Hosted feed/privacy/link execution and independent populated/mobile QA remain pending | Blocked — hosted/independent QA pending |
| Log self slip | recovery/frontend agents | v1 audit agents | Private ex labels are omitted at shared boundaries; `f40344ec2` covers fetch/submit failure, no false success, offline/retry, duplicate guard, and reload | Local typecheck/push gate pass; hosted privacy/failure flow, independent mobile QA, and production persistence remain pending | Blocked — hosted/independent/production proof pending |
| Create named or anonymous report | reporting agents | v1 audit agents | Anonymous reporter redaction is covered; `eac6277ee` rejects self-reporting; reporting UI/API seams are authored | Hosted Postgres/browser and independent named/anonymous authorization QA remain pending | Blocked — hosted/independent proof pending |
| Screenshot evidence attachment | reporting agents | v1 audit agents | `42d203f33`/`9bae5c9fa` validate real PNG/JPEG/WebP files and limits, persist them in Postgres, and render thumbnails/fullscreen viewer | Local contracts/push gates exist; current-head hosted, independent hands-on image QA, backup/restore, and production durability remain pending | Blocked — hosted/independent/production proof pending |
| Note-or-image reporting invariant | reporting agents | v1 audit agents | `42d203f33`/`9bae5c9fa` enforce text or at least one valid image at client/schema/API seams | Authored local seams exist; current-head hosted boundary/UI execution and independent empty/text-only/image-only QA remain pending | Blocked — hosted/independent proof pending |
| Resolve report outcomes | reporting agents | v1 audit agents | Own/deny behavior and failed-mutation recovery are covered by report seams and `f8df0df1d` | Hosted Postgres/browser execution and independent accused/non-accused authorization QA remain pending | Blocked — hosted/independent proof pending |
| Report create/resolve atomicity | `final_spec_review` | `fix_pr_browser_ci` pending | Final spec review found that report/evidence/activity creation and own-resolution slip/tally/status writes were separate queries, so failures could persist partial reports and concurrent resolutions could double-charge. `a05010b68` adds transactions, locks the report/jar/membership rows, and makes own/deny resolution exactly once. It adds authenticated HTTP tests with a Postgres failure trigger for all-or-nothing creation and concurrent own requests asserting one slip, one tally increment, one activity, and one terminal outcome; `f71ea4df9` scopes the rollback assertion around the pre-existing join activity. Product typecheck and focused pre-commit gates passed after the fixes | Host Vitest is blocked by the recorded uninterruptible macOS esbuild condition. Fresh Linux Postgres and independent execution are still required | Blocked — implementation/test correction complete; hosted runtime and independent retest pending |
| Report history and evidence detail | reporting agents + `fix_ci_apple_arch` | v1 audit agents | `fe8f93565`/`4a77eb0f6` add durable history/detail, activity links, reload and state stories; `81555750b` preserves closed-jar history; `55568464c` adds state QA; `205863490` records audit | Authored seams and local gates exist, but failed/superseded runs are not acceptance; current-head hosted and independent history/evidence QA remain pending | Blocked — hosted/independent proof pending |
| Settle display | recovery/frontend agents | v1 audit agents | `7ea259720` prevents false `$0` and adds retry; `900985fc7` scopes retry amount; payment action remains explicitly inert | Hosted loaded positive/zero states and independent mobile visual QA remain pending; real payments are outside this v1 | Blocked — hosted/independent display QA pending |
| Close jar | recovery/frontend agents | v1 audit agents | `725271799`/`23e24e14d` persist/deserialize closure; `c34b27741` adds confirmed owner UI, read-only history, Storybook, and Playwright | Local Postgres/reload seams exist; hosted, independent hands-on, and production persistence/backup proof remain pending | Blocked — hosted/independent/production proof pending |
| Leave jar | recovery/frontend agents | v1 audit agents | `a0e0c0ea5` preserves history; `c34b27741` adds confirmed member UI; `e324710c7` isolates departed members | Local authorization/reload seams exist; hosted, independent owner/member/former-member QA, and production proof remain pending | Blocked — hosted/independent/production proof pending |
| Sessions and logout | auth agents | v1 audit agents | `72dd17844` proves absolute expiry/concurrency/logout in real Postgres/Hono; `acec8fc8a` covers transient failures, confirmed 401, reload, and revoke-before-clear; `9536caa99` models restore states | Direct/local seams pass; current-head hosted, independent browser, physical presentation, and production account/session persistence remain pending | Blocked — hosted/independent/production proof pending |
| Authorization and data isolation | `fix_frontend_quality` + auth/report agents | v1 audit agents | `cc826c230` covers owner/member/accused/former/outsider across jar, invite, slip, streak, report, close, and leave with hidden/nonexistent equality; `e324710c7` isolates departed users | Direct real-Postgres spot proof passes; hosted runs were superseded, independent reconciliation and production isolation remain pending | Blocked — hosted/independent/production proof pending |
| Loading, error, validation, and empty-state coverage | feature owners | v1 audit agents | `7ea259720`/`f8df0df1d`, `f40344ec2`, `4a77eb0f6`/`55568464c`, and `bdec66cee` cover the targeted fetched and mutation states across core screens | Authored seams/local gates exist; current-head hosted Storybook/Playwright, independent hands-on visual QA, and production network behavior remain pending | Blocked — hosted/independent proof pending |
| Mobile accessibility and navigation | `fix_ci_apple_arch` | v1 audit agents | `506dacad0` adds labelled 44px controls, switches, and viewer focus/Escape/return; `182fc9c46` aligns locators; `c9cf37afb` covers subpixel touch; `744f41dad` records 320px QA | Current-head hosted accessibility suite and physical VoiceOver, rotor, rotation, Dynamic Type, and touch QA remain pending | Blocked — hosted and physical QA pending |
| Recovered design versus implementation audit | v1 audit agents | v1 audit agents | Design reference is retained as documentation via `791f46407`; integrated standards/spec reviews produced and drove the listed fixes | Final independent reconciliation still has open evidence rows and production/physical blockers; no clean v1 design sign-off exists | Blocked — independent sign-off pending |
| Notifications | Future increment | v1 audit agents | README/migration and v1 scope decision agree | Explicitly excluded from restoration v1; delivery is not claimed | Not applicable — recorded v1 scope |
| Production web/API and persistence | infra/release agents | external-user acceptance | Infra/container gates exist; immutable `31866340124` proves branch images/tests at `456e5b619` | Merge/deploy, public HTTPS/API, CNPG migration/restart, backup/restore, and second deployment are all pending | Blocked — production not deployed or verified |
| TestFlight and external install | Apple/release agents | external-user acceptance | `784b29b49` and `05eb9aadb` add build/publishing/acceptance seams; ASC read-only baseline and `f54bd9ea5` signing-preflight note exist | Signed upload, Friends group/link, non-team install, physical core-flow exercise, and production Apple sign-in remain pending | Blocked — signed/external evidence absent |

Every blocked row requires a fixing commit and a fresh evidence entry. This table
must be expanded or split if the audit discovers another independently testable
feature; it is not a waiver for capabilities not listed here.

### Authorization matrix contract

The raw authenticated API suite treats an invite code as a capability, but does
not let a jar or report identifier reveal whether a resource exists. `404` below
therefore means the same response for a former member, an outsider, and an
unknown identifier. An active non-owner may receive `403` for an owner-only
operation because their authorized jar read already establishes existence.

| Action | Active owner | Active member | Accused member | Former member | Outsider |
|---|---:|---:|---:|---:|---:|
| Read jar | 200 | 200 | 200 | 404 | 404 |
| Preview open invite by code | 200 | 200 | 200 | 200 | 200 |
| Join/rejoin open invite by code | 200 idempotent | 200 idempotent | 200 idempotent | 200 reactivates | 200 joins |
| Log slip / change own streak sharing | 200 | 200 | 200 | 404 | 404 |
| Create report against another active member | 200 | 200 | 200 | 404 | 404 |
| Read report in an active jar | 200 | 200 | 200 | 404 | 404 |
| Pending report list | Own accused reports only | Own accused reports only | Own accused reports only | Empty | Empty |
| Resolve report | 404 unless accused | 404 unless accused | 200 for own pending report | 404 | 404 |
| Read resolved report history | 200 for active jar reports | 200 | 200 | Empty | Empty |
| Close jar | 200 | 403 owner required | 403 owner required | 404 | 404 |
| Leave jar | 409 must close | 200 | 200 | 404 | 404 |
| Preview/join after close | 404 | 404 | 404 | 404 | 404 |

The matrix is exercised from raw HTTP requests with separate owner, member,
accused, former-member, and outsider sessions against real Postgres. It also
asserts that hidden and nonexistent jar/report responses have identical bodies.

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

Associated Domains update captured 2026-08-14 from the signed-in Apple Developer
portal:

- App ID `2L6ZW5KHV8` (`co.worldwidewebb.textyourex`) had Sign in with Apple
  enabled, but Associated Domains was unchecked. Associated Domains was enabled
  and saved for production invite links.
- Existing App Store provisioning profile `86NB48QVCM` was regenerated without
  uploading a build.
- Apple's regenerated-profile review still listed only In-App Purchase and Sign
  In with Apple. Associated Domains therefore remains unproven until the fresh
  profile is downloaded and decoded and the signed-build guard reads the
  entitlement from both the embedded profile and app binary.

Local signing preflight captured 2026-08-14, without uploading a build:

- The locally installed `match AppStore co.worldwidewebb.textyourex` profile,
  decoded before the latest portal regeneration, is valid through 2027-04-12
  but contains neither `com.apple.developer.applesignin` nor
  `com.apple.developer.associated-domains`.
- The installed development profile contains Sign in with Apple but does not
  contain Associated Domains. It is not a substitute for the App Store profile.
- A valid Apple Distribution identity for team `X9E4HG27NK`, Xcode 26.2, and
  fastlane 2.236.0 are available locally.
- A manual Release archive using the existing App Store profile stops before
  compilation with Xcode exit 65: the profile does not include Sign in with
  Apple, Associated Domains, or their corresponding entitlements. No archive or
  upload was produced.
- The portal capability change and profile regeneration are complete. A fresh
  profile download and entitlement decode, successful signed archive, and any
  upload remain blocked until profile `86NB48QVCM` is verified to carry both
  required entitlements. Do not upload a build before that verification passes.

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
- 78%: sent as event `b9jCrmgKpUxT` after privacy boundaries and the first
  deep-link implementation landed. It explicitly listed sessions, close,
  report history, error/avatar/accessibility QA, production, and TestFlight as
  remaining.
- 82%: sent as event `H3DHe2csbLRS` after immutable run `31866340124` went green
  and avatar, backend/frontend session semantics, and the first recoverable
  fetched-state set were committed. It explicitly stated the app was not yet
  deployed and listed close, report history, accessibility/mobile, production,
  signed TestFlight, and external-user proof as remaining.

## Standards review remediation

Captured 2026-08-14 on branch `codex/dont-text-your-ex-restoration`:

- Native Capacitor plugin results and the API invite-code route are parsed at
  their trust boundaries, with malformed payload and route tests.
- App restore, Apple sign-in, jar lifecycle, invite, report resolution, slip,
  create, and profile mutations use discriminated states; route and API status
  switches are exhaustive.
- Apple cancellation remains a quiet return to idle, while non-cancellation
  native failures show an honest, retryable error with Storybook interaction
  coverage.
- Store and database-row seams retain nominal `UserId`, `JarId`, `ReportId`, and
  `InviteCode` types; compile-time assertions protect the public persistence
  contract.
- Strict hosted Storybook fixtures were repaired for public user data and valid
  report identifiers. The atomic-report rollback assertion now ignores the
  legitimate membership join activity.
- Implementation is present through commit `be07d1dcb`. Product API and frontend
  TypeScript checks, targeted Biome checks, full Knip, and the pre-commit and
  pre-push hooks passed locally.
- Focused local Vitest processes could not execute because the host has existing
  uninterruptible esbuild processes. Hosted CI runs `31868853900` (push) and
  `31868856502` (pull request) are the runtime-test authority for this commit and
  were still queued/in progress when this entry was written.
