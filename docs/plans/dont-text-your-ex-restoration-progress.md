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
| `55c1c8894` | Independent report privacy, rollback, concurrency, authorization, retry, and reload QA | Linux Node 26.7.0 + Postgres 17 passed the expanded full store suite 30/30. Raw responses for both users retain only their own private ex list on `/me`; jar list/detail/preview, member data, activity, pending reports, own/deny responses, resolved history, and both resolved details contain no `exes`, `exLabel`, or seeded private values. Forced report-create activity failure leaves zero report/evidence/report-activity rows. Concurrent own requests yield one 200 and one 404, one owned outcome, one report slip, one $5 tally delta, and one linked slip activity. Forced own-status and deny-activity failures roll back every preceding write to pending/zero deltas; unauthorized callers and terminal retries receive 404; retry after removing the failure succeeds and fresh detail/history reads retain the terminal outcome |
| `35da52864` | Explicit entry/report recovery states and branded sessions | Join preview/submit and report-member fetch/submit use discriminated states with visible retry and no false success; `SessionToken` remains branded through storage and auth transitions with compile-time rejection tests; shared buttons now carry native disabled semantics; invite-rotation E2E waits for the completed UI transition before reading persistence. Frontend typecheck and focused Biome/pre-commit gates passed; immutable hosted run `31869366940` is pending |
| `b2fa4fc4e` | Independent final frontend recovery and former-member reporting fix | Independent QA found historical/departed jar members were still offered as report targets although the API rejected them. Member DTOs now expose active membership without erasing historical leaderboard rows; raw API assertions prove owner/active and former/inactive serialization plus former-target rejection; Report Member filters former members. Submission success is bound to an immutable accused/anonymous snapshot, all mutable controls are natively disabled in flight, and note/image/anonymous/target choices survive failure for retry. Browser coverage now exercises report fetch 401/403/5xx/offline recovery, failed-send preservation/no false success, invalid/404/403/409/5xx/offline invite preview recovery, and Zod-parsed invite rotation reload. Exhaustive state labels replace fallback conditionals and the ambiguous nested-alert Storybook assertion is fixed. Biome, API/frontend typechecks, and pre-commit passed; hosted product E2E passed in run `31869723028`, while Storybook independently caught that the fake seeded invite hint remained visible in its development-mode runtime |
| `642560ac1` | Remove fake seeded invite hint in every runtime | Join no longer advertises `XEX24K`; the independent Storybook absence assertion remains unchanged. Focused Biome, frontend typecheck, Knip, and pre-commit passed; immutable hosted Storybook rerun pending |
| `d2f7eeeb7` | Final standards audit remediation | All remaining Playwright API response bodies use shared Zod contracts, including branded dev-session tokens and jar lifecycle reads. Create, Apple sign-in, slip, sign-out, invite replacement, close, and leave button labels now exhaustively switch over their discriminated states. API/frontend typechecks, 18-test Playwright discovery, focused and full tracked Biome, Knip, pre-commit, and pre-push passed; exact-commit hosted execution pending |
| `3415cf1da` | Remove final unsafe response and style casts | Independent exact-HEAD standards QA found two API test response casts plus five non-parser structural casts. Jar detail and report-history responses now parse the shared Zod contracts, authorization-matrix actors come from a typed readonly tuple, SVG styles use their native React type, and the Money Burst custom property has an explicit `CSSProperties` extension. API/frontend typechecks, focused and full Biome, Knip, staged pre-commit, and pre-push passed. A second independent standards review returned PASS with no hard findings; the proportionate spec review found no behavior or scope change. Local Vitest again stalled silently in the host's known esbuild condition and was stopped, so exact-commit hosted CI is the runtime authority |

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

Split into capability-level rows at `9536caa99` and reconciled one acceptance
capability per row by `final_exact_spec`. `/root` names the coordinating agent
when the durable record does not attribute a commit to a narrower task. `Unassigned`
means no named independent QA execution is recorded; that is a release blocker,
not implied approval. The latest completed fully green immutable run is
`31866340124` at `456e5b619`, before many commits below. Exact-head hosted proof
must name its immutable SHA and run before a row can pass.

| Feature | Implementation owner | Independent QA | Automated/hands-on evidence | Defects or missing states | Result |
|---|---|---|---|---|---|
| Physical production Sign in with Apple | `apple_release`, `fix_ci_apple_arch` | Unassigned — physical external QA required | `784b29b49` restores the native bridge and `cd4af8715` parses plugin results; unsigned simulator build passed | No signed physical success/cancel/reload/cellular exchange or production account proof | Blocked — named physical QA absent |
| Apple issuer, audience, signature, nonce, and state validation | `apple_release`, `/root` | `qa_auth_profile` | Independent source audit confirmed `jwtVerify` pins Apple issuer and `co.worldwidewebb.textyourex`, hashes and checks the raw nonce, and the native seam binds both random attempt ID and state. Focused unit cases cover valid exchange plus wrong issuer, audience, signature, nonce, missing nonce, substituted/missing state, replayed attempt ID, and schema-invalid native responses. Production errors omit verifier detail and logs never include the identity token | Local Vitest entered the known silent host stall and was stopped; exact-commit hosted execution and a real Apple token exchange remain absent | Automated PASS pending hosted confirmation; live Apple Blocked |
| Returning Apple user without `fullName` | `/root` | `qa_auth_profile` | Independent unit inspection verifies the existing Apple subject is reused, its saved name is not overwritten, no second user is created, and a fresh independently revocable session is returned when `fullName` is absent | No production returning-user exchange or physical reload has run | Automated PASS; live Apple/production Blocked |
| New Apple user without an Apple-provided name | `/root` | `qa_auth_profile` | Independent unit coverage verifies an absent name is persisted as empty without an invented fallback and returns `needs_profile`. Browser QA starts from that exact response, requires user-entered naming, reaches the empty account, reloads, and reads the saved name from Profile | The headless browser uses the non-production session seam, not a real Apple authorization | Automated PASS pending hosted confirmation; live Apple Blocked |
| Development authentication disabled in production | `app_recovery` | `qa_auth_profile` | Independent API-boundary QA sets the real runtime configuration to production and verifies both `/auth/dev` and `/test/reset` return the same 404 `not_found` response without touching persistence; production seeding separately proves zero inserted users. Development retains schema validation for the explicit test seam | Exact-commit hosted execution and deployed-production raw requests remain absent | Automated PASS pending hosted confirmation; production Blocked |
| Session creation, persistence, expiry, and logout/revocation | `/root`, `release_standards_rereview` | `qa_auth_profile` | Independent Postgres-test audit covers a fixed 30-day absolute lifetime, last-used refresh without expiry extension, lazy deletion after expiry, two independently valid tokens, and logout revoking only the presented token. Frontend tests retain the local token through network/5xx/invalid-response restore failures, clear only on confirmed 401, retain it after failed logout, and clear after successful retry. Browser reload after first-run setup proves local restoration | Exact-commit hosted Postgres/browser execution and production pod-restart persistence remain absent | Automated PASS pending hosted confirmation; production Blocked |
| First-run onboarding | `/root` | `qa_auth_profile` | Independent unit and browser QA covers Apple returning `needs_profile` with an empty name, disabled submission until user input, successful save, useful empty home, and persisted name after a full reload. Storybook separately covers normal first visit, session expiry, quiet cancellation, and retryable native failure without false success | Real Apple first authorization and physical interruption/reload remain untested | Automated PASS pending hosted confirmation; live Apple/physical Blocked |
| Later profile and avatar editing | `fix_ci_apple_arch` | `qa_auth_profile` | Independent browser QA rejects a spoofed PNG, accepts and saves a real PNG, renders it immediately, reloads, renders the persisted data again, and toggles streak sharing. The same profile surface exposes name/color/emoji/photo editing | Physical iOS picker and production Postgres restart persistence remain untested | Automated PASS pending hosted confirmation; physical/production Blocked |
| Avatar MIME, signature, and size limits | `fix_ci_apple_arch` | `qa_auth_profile` | Independent boundary audit finds shared client/server parsing for PNG/JPEG/WebP MIME plus magic signatures and a 2 MiB decoded-byte limit. Unit cases accept all three formats and reject URL input, MIME spoofing, unsupported signatures, and oversize data; browser QA exercises spoof rejection, real PNG save, render, and reload | No physical iOS picker run; exact-commit hosted execution remains pending | Automated PASS pending hosted confirmation; physical Blocked |
| Private profile data isolation | `final_spec_review` | `backend_release_qa` | Final spec review found that shared member, activity, and report DTOs reused the private profile schema and exposed every referenced user's `exes`. `925511eaf` splits public users from `/me` and removes ex labels from shared DTOs. `55c1c8894` independently exercises both authenticated viewers against real Postgres: each `/me` retains only that viewer's private ex list, while raw jar list/detail/preview, member data, activity, pending reports, own/deny responses, resolved history, and owned/denied detail JSON contain neither private keys nor any seeded private value. Linux Node 26.7.0 + Postgres 17 passed the expanded store suite 30/30 | The original data-exposure defect and the missing resolved/two-viewer QA states are fixed and independently retested. Current immutable hosted execution and production isolation remain pending | Blocked — code/independent Postgres pass; hosted/production proof pending |
| Useful empty-account state | `/root` | `qa_auth_profile` | Independent Storybook QA covers loading, failed fetch, retry, then true empty; browser QA creates an unnamed first-run account, supplies the required name, verifies the honest no-jars message plus both Create and Join actions, reloads, and sees the same empty state. Seeded-account browser coverage separately proves the populated state | Exact-commit hosted execution and physical mobile visual QA remain absent | Automated PASS pending hosted confirmation; physical Blocked |
| Create a jar | `/root`, `release_spec_rereview` | `backend_release_qa` | `f40344ec2` covers retry/duplicate submit; `742834f79` makes jar/invite/owner membership atomic; independent Postgres suite passed 28/28 | Exact-head hosted and production persistence/reload absent | Blocked — hosted/production proof pending |
| Copy/share invitation and complete invite screen | `fix_frontend_quality`, `/root` | Unassigned | `28c2dacaa`, `3720d8609`, `456e5b619`, `f03617886`, and `bdec66cee` implement completion, canonical share links, expiry display, and owner replacement | Named independent share-sheet and physical QA absent | Blocked — independent/physical proof pending |
| Join through a valid invitation | `/root`, `release_spec_rereview` | `backend_release_qa`, `final_ui_qa` | `742834f79` serializes admission; Postgres 28/28; `b2fa4fc4e` adds valid retry/recovery browser paths | Exact-head hosted and physical deep-link execution absent | Blocked — hosted/physical proof pending |
| Invalid, expired, or unauthorized join failures | `/root` | `final_ui_qa` | `b2fa4fc4e` covers invalid input and 404/403/409/5xx/offline preview failures, hidden stale content, successful retry, and an assertion that no fake seeded code appears; hosted run `31869723028` passed product E2E but failed that assertion under Storybook because the hint was only development-gated. The follow-up removes it in every runtime without weakening the test | Follow-up immutable hosted Storybook execution pending | Blocked — follow-up hosted proof pending |
| Invitation expiry, revocation, and closed-jar old links | `fix_frontend_quality`, `/root` | Unassigned | `f03617886`, `bdec66cee`, `463e89e73`, `f8718fc02`, `ebc5b8c40`, and `742834f79` cover seven-day expiry, replacement, closed links, reload, and races | Named independent seven-day-boundary/physical QA absent | Blocked — independent/physical proof pending |
| Non-member jar isolation | `fix_frontend_quality`, `final_spec_review` | `backend_release_qa` (privacy subset) | `cc826c230`, `925511eaf`, and `55c1c8894` cover owner/member/accused/former/outsider reads and hidden/nonexistent equality | Full exact-head hosted and production isolation absent | Blocked — hosted/production proof pending |
| Return to jar after creation/invitation | `/root` | Unassigned | `28c2dacaa`, `f40344ec2`, and browser flows exercise completion navigation | Named independent reload/back-stack and exact-head hosted QA absent | Blocked — independent/hosted proof pending |
| Log a self slip with required validation | `/root` | Unassigned | `f40344ec2` covers fetch/submit failure, no false success, offline retry, duplicate guard, and reload; private labels removed from shared DTOs by `925511eaf` | Named independent mobile/privacy and production persistence QA absent | Blocked — independent/production proof pending |
| Accused member confirms or denies a report | `/root` | `backend_release_qa` | `f8df0df1d` and `55c1c8894` prove accused-only own/deny, 404 callers/retries, induced 500 recovery, and Postgres 30/30 | Hosted UI and production persistence absent | Blocked — hosted/production proof pending |
| Confirmed/denied state visible and durable | `/root`, `fix_ci_apple_arch` | `backend_release_qa` | `fe8f93565`, `4a77eb0f6`, `81555750b`, `55568464c`, and `55c1c8894` preserve outcome, activity link, history/detail, evidence, reload, and closed-jar reads | Hosted UI plus production restart/backup proof absent | Blocked — hosted/production proof pending |
| Unrelated users cannot mutate reports/slips | `fix_frontend_quality` | `backend_release_qa` (report resolution) | `cc826c230` and `55c1c8894` cover the raw authorization matrix and terminal retries | Exact-head hosted and production isolation absent | Blocked — hosted/production proof pending |
| Create named/anonymous report by note, image, or both | `/root`, `release_standards_rereview` | `final_ui_qa` | `42d203f33`, `9bae5c9fa`, `eac6277ee`, `35da52864`, and `b2fa4fc4e` cover real evidence, self-report rejection, immutable submission state, preserved retry form, and no false success | Hosted, production, and physical picker QA absent | Blocked — hosted/production/physical proof pending |
| Note-or-image invariant at UI, contract, and API | `/root` | Unassigned | `42d203f33`/`9bae5c9fa` enforce the invariant at all three seams | Named independent empty/text/image matrix and exact-head hosted execution absent | Blocked — independent/hosted proof pending |
| PNG/JPEG/WebP browser and iOS picker | `/root` | Unassigned | `42d203f33`/`9bae5c9fa` use a real file input accepting all three formats and validated data URLs | Named independent physical iOS WebView picker QA absent | Blocked — independent/physical proof pending |
| Evidence maximum three images and 2 MiB each | `/root` | Unassigned | `42d203f33`/`9bae5c9fa` define and test three-file/2 MiB limits | Named independent boundary and exact-head hosted execution absent | Blocked — independent/hosted proof pending |
| Evidence MIME, signature, count, and size validation | `/root` | Unassigned | `42d203f33`/`9bae5c9fa` validate client/shared/API boundaries for PNG/JPEG/WebP signatures and limits | Named independent malicious-boundary execution absent | Blocked — independent/hosted proof pending |
| Evidence durable in Postgres and backups | `/root`, `production_infra` | Unassigned — production restore QA required | `42d203f33`/`9bae5c9fa` persist payloads; `13b5dc054` declares scheduled Postgres backup | No production backup artifact/restore containing evidence | Blocked — production restore proof absent |
| Real thumbnails and full evidence viewer | `/root`, `fix_ci_apple_arch` | Unassigned | `9bae5c9fa` renders real thumbnails/viewer; `506dacad0` adds viewer focus/Escape/return semantics | Named independent hands-on and physical image QA absent | Blocked — independent/physical proof pending |
| Anonymous reporter identity hidden | `/root`, `final_spec_review` | `backend_release_qa` | `925511eaf` removes private fields; `55c1c8894` proves anonymous pending/history/detail and activity responses hide identity/private values | Production isolation absent | Blocked — production proof pending |
| Report outcome/evidence survives reload and restart | `/root`, `fix_ci_apple_arch` | `backend_release_qa` (reload subset) | `fe8f93565`, `4a77eb0f6`, `81555750b`, and `55c1c8894` prove fresh reads after resolution/failure recovery | API/database pod-restart and backup/restore proof absent | Blocked — production durability proof pending |
| Resolved reports remain authorized history | `/root`, `fix_ci_apple_arch` | `backend_release_qa` | `fe8f93565`, `4a77eb0f6`, `81555750b`, `55568464c`, and `55c1c8894` cover list/detail, close, outcomes, evidence, and privacy | Hosted UI and production backup/restore absent | Blocked — hosted/production proof pending |
| Report create/resolve atomicity | `final_spec_review` | `backend_release_qa` | Final spec review found that report/evidence/activity creation and own-resolution slip/tally/status writes were separate queries, so failures could persist partial reports and concurrent resolutions could double-charge. `a05010b68` adds transactions and row locks; `f71ea4df9` corrects the creation assertion. `55c1c8894` independently proves on Linux Node 26.7.0 + Postgres 17 that induced report-create failure leaves zero report/evidence/report-activity rows; two concurrent own requests produce one 200 and one 404, one owned status, one report slip, one $5 tally delta, and one linked activity; induced own-status and deny-activity failures restore pending status with zero partial slip/tally/activity writes; retries then persist exactly one terminal outcome. Expanded store suite: 30/30 | Original atomicity defect is fixed. SQL inspection confirms report creation shares one transaction and resolution locks the report row before terminal-state validation, then uses the same transaction for jar/membership locks and all outcome writes. Current immutable hosted execution and production persistence remain pending | Blocked — code/independent Postgres pass; hosted/production proof pending |
| Home and activity: empty and populated | `/root` | Unassigned | `7ea259720`, `e77c5784a`, `ce2bccf34`, and `4a77eb0f6` cover loading/error/empty/retry, populated feed, and report links | Named independent mobile visual and exact-head hosted QA absent | Blocked — independent/hosted proof pending |
| Core actions reachable without dead ends | `/root` | `final_ui_qa` (focused report/join audit) | `28c2dacaa` restores invite completion; `b28613dde` fixes pointer interception; `b2fa4fc4e` removes former report targets and stale join states; the follow-up removes the fake seeded join hint in all runtimes | Full named independent navigation sweep, follow-up hosted Storybook, and physical QA absent | Blocked — hosted/independent/physical proof pending |
| Settle display and close-jar lifecycle | `/root` | `qa_auth_profile/lifecycle_followup` | Independent source and automation audit verifies Settle never renders a false `$0` while loading/error/nonmember, retries offline fetch to the exact `$5` balance, and keeps payment disabled and explicitly future-scoped. Owner close requires confirmation; member close is absent/403; invalid confirmation is 400; close persists actor/time, revokes old invites, blocks slip/report/streak/outcome mutations, retains tally/activity/member history, becomes read-only in the UI, and survives reload | Current exact-head hosted execution and production restart/backup proof remain absent | Automated PASS pending hosted confirmation; production Blocked |
| Leave-jar lifecycle and historical membership | `/root` | `qa_auth_profile/lifecycle_followup` | Independent Postgres/browser QA verifies confirmation, owner 409, outsider/former 404, active member leave, immediate and post-reload loss of list/detail/activity/pending access, owner-visible inactive historical row and preserved `$7` tally, current preview/count isolation, former-target rejection, then valid-link rejoin with the same membership history/tally and pending report restored after reload. The UI hides owner-only close from members and redirects a successful leave home | Current exact-head hosted execution and production restart proof remain absent | Automated PASS pending hosted confirmation; production Blocked |
| Honest loading, error, validation, offline, expired-session, and empty states | `/root`, `release_standards_rereview` | `qa_auth_profile/lifecycle_followup` | Independent sweep maps every v1 surface to automation: Home/Activity/Jar/Settle/Confirm/History detail-list loading/error/retry/true-empty stories; Create/Invite/Join/Slip/Report fetch and mutation offline/4xx/5xx retry paths; preserved forms and duplicate-submit guards; logout retry; confirmed-401 expiry versus transient session retention; Apple cancellation/native/API failure; populated and first-run empty browser paths. Assertions prohibit false balances, false success, contradictory invite hints, and cleared retry input | Current exact-head hosted Storybook/browser execution and real production network behavior remain absent | Automated PASS pending hosted confirmation; production Blocked |
| Mobile accessibility and navigation | `fix_ci_apple_arch` | `qa_auth_profile/lifecycle_followup` | Independent audit verifies named semantic buttons/switches/avatar and evidence controls, modal focus trap/Escape/focus return, disabled mutation controls, and browser automation at 320×700 touch viewport. The test rejects horizontal overflow, requires 44 CSS-pixel Create/Back/switch targets with subpixel-only tolerance, taps between Home/Create/Profile, and keyboard-toggles the labelled streak switch | Physical VoiceOver, rotor, rotation, Dynamic Type, safe-area, and real-touch QA remain absent | Automated PASS; physical accessibility Blocked |
| Recovered design versus implementation audit | `final_spec_review`, `release_spec_rereview`, `release_standards_rereview` | `final_exact_spec`, `final_ui_qa` (focused rereviews) | `791f46407` retains design sources; reviews drove privacy, atomicity, state-model, invite-race, and former-target fixes through `b2fa4fc4e` | Exact-head independent reconciliation and all live gates remain open | Blocked — final sign-off pending |
| Notifications | Future increment — no implementation owner | `final_exact_spec` (scope reconciliation) | README, migration, and v1 scope decision explicitly exclude push/preferences | Explicitly outside restoration v1 | Not applicable — recorded v1 scope |
| Production web/API and persistence | `production_infra` | Unassigned — external production acceptance required | `13b5dc054`, `522ce187d`, `0926f77f5`, and `d24742b83`; immutable `31866340124` proves earlier branch images/tests | Merge/deploy, public HTTPS/API, CNPG migration/restart, backup/restore, and second deployment pending | Blocked — production unverified |
| TestFlight and external install | `apple_release`, `fix_ci_apple_arch` | Unassigned — non-team external acceptance required | `784b29b49`, `05eb9aadb`, `f54bd9ea5`, and `ad939cb77` define build/release and record signing state | Signed upload, Friends group/link, non-team install, physical core flow, and production Apple sign-in pending | Blocked — signed/external proof absent |

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
