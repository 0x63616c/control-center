# Don’t Text Your Ex — Public App Store Release Control

> **COMPACTION / CONTINUATION INSTRUCTIONS — READ THIS FIRST**
>
> This is the durable source of truth for the goal **publish Don’t Text Your Ex
> on the public Apple App Store and prove an ordinary user can download and use
> it**. After any context compaction, new session, or handoff, load this document
> before doing work. Then read the linked V1 acceptance and execution ledger,
> refresh repository/App Store Connect/production state, and resume deterministically:
> (1) read `AGENTS.md` and this document; (2) call `get_goal` and confirm the
> active goal; (3) fetch and record `origin/main`, worktree/branch/dirty state,
> live agents, last evidence row, and current external state; (4) resume the one
> `IN PROGRESS` packet, otherwise choose the lowest-numbered dependency-ready
> `NOT STARTED` packet; skip `BLOCKED` packets until their named condition clears;
> (5) re-check explicit approval gates before submit/release. Do not restart
> completed work, trust stale status, or report a processed/TestFlight build as
> public release proof.
>
> Keep this file current in the same change that moves a packet. Record exact
> commits, builds, workflow URLs/IDs, screenshots, public URLs, and redacted
> machine evidence. A checkbox is not evidence. Never record credentials,
> tokens, Apple subjects, private screenshots, tester email addresses, or other
> personal data here.

## Goal and completion boundary

The goal is complete only when all mandatory packets below are `PROVEN`, Apple
has approved version 1.0, the release is publicly visible in the intended
storefronts, a fresh non-TestFlight device/account can download the App Store
binary, Sign in with Apple and the core two-user flow work against production,
and post-release health/support/moderation checks pass.

Apple approval is an external decision. The operating commitment is to drive
the app through implementation, submission, review remediation, approval,
release, and public verification rather than stopping at “submitted.”

Locked identity and targets:

- Repository: `0x63616c/world-wide-webb`
- App path: `apps/dont-text-your-ex`
- Product name: **Don’t Text Your Ex** (saved in App Store Connect; still
  subject to App Review)
- Bundle ID: `co.worldwidewebb.textyourex`
- Version: `1.0`
- Production: `https://dont-text-your-ex.worldwidewebb.co`
- Kubernetes namespace: `dont-text-your-ex`
- Production stack: `home-server`
- Apple app ID: `6778544752`
- Software-factory tracker: `T-41`
- Notification endpoint: `https://ntfy.sh/0x63616c`

Related sources that remain authoritative for their scope:

1. [`dont-text-your-ex-v1-release.md`](./dont-text-your-ex-v1-release.md) —
   restored product behavior and V1 acceptance.
2. [`dont-text-your-ex-restoration-progress.md`](./dont-text-your-ex-restoration-progress.md)
   — historical implementation and production evidence; its later live-evidence
   section supersedes stale earlier blocked rows.
3. [`dont-text-your-ex-restoration.md`](./dont-text-your-ex-restoration.md) —
   recovery and infrastructure plan.
4. `apps/dont-text-your-ex/docs/publishing-ios.md` — current signing/TestFlight
   pipeline.
5. Current source, tests, immutable CI, live production, App Store Connect, and
   physical-device observations — current evidence wins over memory.

## Operating protocol

### Task sizing and delegation

- Work one small-to-medium, dependency-ready packet at a time. Split a packet if
  it cannot be implemented, verified, and documented coherently within a
  context window.
- Keep at most one coordinating packet `IN PROGRESS` unless this document names
  an explicit parallel set with separate owners and non-conflicting inputs.
- Use subagents for most bounded implementation, research, asset, QA, and
  independent-review work. The coordinating agent owns dependency order,
  integration, evidence reconciliation, external actions, and the final truth.
- Implementation and independent QA should be separate agents whenever
  capacity permits. The creator of a screenshot/icon/listing asset cannot be its
  only reviewer.
- Follow `AGENTS.md`: use a `wtp` worktree, branch from `origin/main`, use the
  repository’s software-factory ticket workflow when creating implementation
  tickets, commit and push coherent slices, open a PR, merge only green work,
  and deploy only the `home-server` stack.
- Never read or print secret values. Evidence must be redacted and must identify
  what was checked without exposing the value checked.

### Status vocabulary

- `NOT STARTED` — no current execution evidence.
- `IN PROGRESS` — active work exists but acceptance is incomplete.
- `BLOCKED` — a named dependency, Apple state, or user-only action prevents
  meaningful progress.
- `PROVEN` — every mandatory acceptance item has current recorded evidence.
- `N/A` — explicitly excluded with a recorded reason and owner approval.

Only `PROVEN` and approved `N/A` earn progress. Code completion without current
tests, visual review, deployment, or required live/device evidence earns no
packet credit.

Requirement classes used below:

- `APPLE REQUIRED` — Apple submission, policy, or distribution requirement.
- `PROJECT GATE` — an intentionally stricter release-quality requirement for
  this project, even when Apple does not mandate the exact mechanism.
- `RECOMMENDED` — strongly preferred but not completion-blocking unless promoted
  by an owner decision.
- `CONDITIONAL` — required only when the named capability, region, or business
  condition applies.
- `OWNER-ONLY` — legal/business attestation or irreversible external decision
  that Calum must confirm.

For example, Apple requires 1–10 accurate screenshots, but this project’s 5–7
image narrative, deterministic composition pipeline, external TestFlight pass,
and independent visual review are `PROJECT GATE`s rather than Apple mandates.

### Progress formula

Progress is the sum of the weights of `PROVEN` packets. Do not estimate by time
spent or old checkbox count. Historical production restoration is represented
by `P00`; it is not re-counted in later packets.

| Packet | Weight | Packet | Weight |
|---|---:|---|---:|
| P00 | 5% | P09 | 5% |
| P01 | 4% | P10 | 7% |
| P02 | 4% | P11 | 5% |
| P03 | 8% | P12 | 8% |
| P04 | 4% | P13 | 9% |
| P05 | 8% | P14 | 7% |
| P06 | 5% | P15 | 5% |
| P07 | 6% | P16 | 3% |
| P08 | 4% | P17 | 3% |

Total: **100%**. `Submitted`, `approved`, and `publicly verified` are distinct
milestones. Never report 100% at submission or approval alone.

### Notifications and user requests

Send concise notifications to `https://ntfy.sh/0x63616c` at:

- project start;
- each newly proven packet or meaningful milestone (batch tiny events);
- every 10-point progress crossing;
- any blocker or user/legal/physical-device action needed;
- submission, review decision, resubmission, approval, release, and final public
  verification.

Each message must contain: project, honest percentage, current milestone,
blockers, user action if any, and what remains. Do not include PII or secrets.
Record the returned ntfy event ID in the notification ledger.

Notify Calum instead of guessing for:

- legal entity/privacy-policy owner and content-rights attestations;
- DSA trader status and any regional regulatory declaration;
- price, tax, territories, developer/paid agreements, or banking/tax identity;
- age/consent stance where it is a product/legal decision;
- retained-data/legal-retention exceptions;
- Apple 2FA or account-holder-only actions;
- final approval immediately before `Submit for Review`;
- final approval immediately before a manual public release.

### Screenshot and visual evidence protocol

- Keep fictional/redacted raw source captures, deterministic final assets,
  manifest, hashes, contact sheet, and QA report in the repository. If App Store
  Connect evidence includes contact information or private account state, commit
  only a redacted derivative; keep the original outside version control or do
  not retain it.
- Inspect every generated image at original resolution and at App Store thumbnail
  size. Check cropping, safe areas, spelling, contrast, status bar, fictional
  data, accurate capability claims, and policy-safe tone.
- Use one creator and one independent visual reviewer. Record creator/reviewer
  names or agent task IDs, timestamp, reviewed manifest SHA, pass/fail per asset,
  remediation, and fresh re-review. A global “looks good” is not evidence.
- Capture App Store Connect before/after states for required sections, but redact
  personal contact details and never store credentials.
- Generated or edited images are not accepted merely because a tool completed;
  visual inspection and explicit review are mandatory.

## Current verified baseline — refresh before relying on it

Snapshot date: **2026-08-16T04:19:55Z**.

Proven and reusable:

- The authoritative later monorepo app is restored at
  `apps/dont-text-your-ex`; bundle ID and binary display name are correct.
- Immutable application revision `ecf47add229d590bdce7238e7130fb802e07b9da`
  passed run `31872702467`, including Postgres contracts, Playwright, Storybook,
  typecheck/Knip, images, and both home-server and Cloudflare deployment.
- Current `origin/main` at P00 closure is
  `676623f18479e278baad877742ccc4fa24c30f70` (PR `#705`), containing the
  redacted baseline evidence. PR CI, CodeQL, Storybook, unit, typecheck/Knip,
  and required `test-software-factory` checks passed. Product-specific jobs were
  path-skipped, so these runs prove the merged control/evidence documents and
  current main gates, not a fresh application build or deployment.
- Production frontend/API/CNPG/migrations, public HTTPS, persistence across API
  and database restarts, backup/restore, cleanup, and a second deployment have
  evidence in the restoration ledger.
- Live refresh found namespace `dont-text-your-ex` active; API and frontend
  deployments `1/1` ready with zero pod restarts; CNPG healthy with continuous
  archiving; and the latest scheduled backup job successful. Public Cloudflare
  HTTPS returned `/` 200, `/api/health` 200 with `{"ok":true}`, and unauthenticated
  `/api/me` 401 with `{"error":"not_authenticated"}`. This refresh did not repeat
  the historical destructive restart or scratch-restore tests.
- Signed Build 24 carries Sign in with Apple and Associated Domains in the app
  and provisioning profile. AASA origin and Apple CDN responses were proven.
- The live origin and Apple CDN AASA responses remain exact 164-byte matches
  (`sha256:63a9fc47b8ddbfdec31aa56e72a5bac627d74babdf6742a5f881d37a75f176a2`)
  for app ID `X9E4HG27NK.co.worldwidewebb.textyourex` and `/j/*`.
- Build 24 is processed and assigned to Internal and Friends. The public
  TestFlight link `https://testflight.apple.com/join/6HcbUuV3` exists. Live App
  Store Connect showed Build 24 **Waiting for Review** for Beta App Review;
  Friends has zero testers and cannot accept public-link testers until an
  approved build is available.
- App Store version 1.0 is **Prepare for Submission**. Live inspection showed
  zero screenshots, no App Store build attached, blank version metadata/reviewer
  fields, unresolved app-level setup, and automatic release currently selected.

Known open release gaps:

- No account-deletion domain/API/UI or Sign in with Apple revocation flow.
- Gameplay reporting is not abuse reporting. There is no block-user model,
  operator moderation flow, or objectionable-content filtering.
- `/privacy`, `/support`, `/terms`, and `/community-guidelines` currently return
  the same 1,946-byte SPA shell as `/` rather than genuine public documents.
- `/version.json` is also that SPA fallback, so production currently exposes no
  direct source-SHA/build mapping.
- Runtime/public-facing copy contains “shame,” “guilt,” and accusatory language
  that creates Guideline 1.1/1.2 risk.
- Physical production Sign in with Apple, external non-team install/core flow,
  native picker/share/universal links, and physical accessibility remain open.
- The iOS target declares `TARGETED_DEVICE_FAMILY = "1,2"`; iPad support is not
  physically/visually proven and expands screenshot requirements.
- The current dollar-sign icon can imply real payments. The current splash art
  is default Capacitor artwork and does not match the product.
- There is no deterministic App Store creative/listing pipeline.
- Build 24 is beta evidence, not the public release candidate after compliance
  code changes. Public submission requires Build 25 or later.

## Critical path

```text
P00 -> P01 -> {P02,P03,P05} -> P09 -> P07 -> {P04,P06,P08} -> P10 -> P11 -> P12
{P01,P02,P04,P06,P11,P12} -> P13
{P01,P02,P07,P09,P12,P13} -> P14 -> P15 -> P16 -> P17
```

Parallel work is allowed only when inputs are stable. Do not capture final store
screenshots before final UI/safety/copy work, or publish privacy answers before
the data model/deletion/moderation inventory is final.

## Execution packets

### P00 — Freeze and prove the current baseline — 5%

- **Status:** `PROVEN`
- **Dependencies:** none
- **Deliverables:** this control document; refreshed origin/main SHA, CI state,
  production state, App Store version/build/TestFlight state, baseline evidence
  links, blocker list, progress and notification ledgers.
- **Acceptance:** reconcile the old ledger’s historical blocked rows with its
  newer live-evidence section; distinguish automated, production, Apple, and
  physical-device proof; record live values without secrets.
- **Evidence:** committed document, current repository status, live public probes,
  App Store Connect screenshots/state, TestFlight state, first ntfy event ID.

### P01 — Owner decisions and public-release contract — 4%

- **Status:** `PROVEN`
- **Dependencies:** P00
- **Decisions:** final store name; iPhone-only versus universal iPhone/iPad;
  privacy/legal owner; support contact; copyright; free/paid; territories;
  categories; release mode; DSA trader status; age/consent stance; deletion
  semantics for owned/shared data; moderation SLA and escalation path; standard
  Apple EULA versus optional custom EULA; optional availability on compatible
  Apple-silicon Macs and Apple Vision Pro; protected operator-plane strategy;
  V1 localization scope.
- **Initial release modes:** manually release after approval; automatically
  release after approval; or automatically release no earlier than a selected
  date/time. Phased release applies to updates, not initial version 1.0.
- **Acceptance:** every decision is explicit, dated, attributed, and propagated
  to downstream packets. Legal/business answers are confirmed by Calum, not
  inferred by an agent.
- **Evidence:** decision table in this document plus redacted App Store Connect
  captures where applicable.

### P02 — Supportive positioning and complete copy audit — 4%

- **Status:** `PROVEN`
- **Dependencies:** P01
- **Work:** replace public/runtime “shame,” “wall of shame,” “guilt,” “snitched,”
  “carnage,” “poor impulse control,” and payment-teasing copy with private,
  consensual, supportive accountability. State clearly that the app does not
  read messages or transfer money. Update tests/stories/docs.
- **Acceptance:** no prohibited public/runtime strings except explicitly retained
  historical design references; product still has a coherent, playful voice;
  all changed screens receive visual review.
- **Evidence:** scoped grep report, copy inventory, before/after screenshots,
  unit/Storybook/Playwright results, independent tone/policy review.
- **Dependency-safe implementation (2026-08-15):** supportive runtime copy,
  virtual-point terminology, explicit message-access/no-money disclosures,
  neutral selectors, aligned tests/stories, and an AST runtime-copy regression
  gate are implemented on `codex/dtye-supportive-copy`. Local gates include
  41/41 frontend tests, 55/55 relevant Storybook tests (including all 14 changed
  screens), and 20/20 real-Postgres Playwright tests. All 14 changed-screen
  frames passed independent original-resolution visual review. Rendered evidence
  and proof boundaries are recorded in
  [`docs/evidence/dont-text-your-ex/p02/README.md`](../evidence/dont-text-your-ex/p02/README.md).
  The implementation was merged in PR #709 at `647757a50`; merge-SHA CI,
  CodeQL, the home-server rollout, public HTTPS/API probes, and independent
  reviews all passed. Calum completed P01 on 2026-08-23, satisfying P02's final
  dependency; the existing implementation, deployment, public probes, tests,
  and independent visual review therefore prove this packet.

### P03 — Account-deletion domain, API, and data semantics — 8%

- **Status:** `IN PROGRESS`
- **Dependencies:** P01
- **Work:** transactional authenticated deletion; session revocation; Sign in
  with Apple token revocation; removal/anonymization of profile, avatar, private
  ex labels, uploads, and UGC; deterministic handling of owned jars and friends’
  shared history; idempotency, rollback, and re-registration semantics.
- **Acceptance:** deletion is deletion, not deactivation; shared users are not
  surprised by destructive cascades; old sessions fail; retained data has a
  documented lawful/product reason; repeat deletion is safe.
- **Apple revocation plumbing:** the native bridge/shared contract returns the
  authorization code; the API exchanges it without logging it; required Apple
  key/client-secret configuration is presence-checked only; revocation material
  is protected and retained only per policy. Cover success, already-revoked, and
  transient failure through an injected adapter. Never place codes/tokens in
  logs or evidence.
- **Evidence:** migration/contract; real-Postgres matrix for owner/member/former,
  owned/shared content, evidence, concurrent and failed transactions, second
  delete, old-token rejection, mocked Apple revocation, and re-registration;
  redacted before/after table inventory. Real-token Apple revocation is P12.
- **Apple source:** https://developer.apple.com/support/offering-account-deletion-in-your-app/

### P04 — Account-deletion UI and privacy choices — 4%

- **Status:** `NOT STARTED`
- **Dependencies:** P03, P07 wording
- **Work:** Profile → Delete Account; clear consequences; confirmation; pending,
  offline, failure, retry, and success states; local credential cleanup; policy
  links; accessible focus and controls.
- **Acceptance:** easy to find, understandable, no false success, successful
  deletion returns to authentication, and re-registration follows the approved
  semantics.
- **Evidence:** Storybook, Playwright pointer flow, local accessibility/focus/
  44-point review, and screenshots. Physical deletion/re-registration is P12.

### P05 — UGC safety backend and moderation model — 8%

- **Status:** `IN PROGRESS — LOCAL IMPLEMENTATION/VERIFICATION`
- **Dependencies:** P01
- **Work:** separate abuse reports from gameplay reports; block/unblock model;
  blocked interaction semantics; objectionable-text filtering at all relevant
  server boundaries; moderation statuses/audit; layered rate limiting; safe
  evidence handling and operator authorization. Add a Cloudflare Worker route
  scoped exactly to `dont-text-your-ex.worldwidewebb.co/api/*`, using separate
  Rate Limiting API bindings for the broad API, authentication, invite probing/
  joining, uploads/reports, and other state-changing operations. This deliberately
  replaces the originally proposed zone-level WAF rules: the Free zone plan has
  only one WAF rate-limit rule, while the product requires five independently
  testable budgets. Add corresponding API-side per-user and trusted-client-IP
  limits so origin safety does not depend solely on Cloudflare. Worker binding
  errors fail closed; the origin layer remains authoritative if edge counters are
  permissive/eventually consistent. Production deployment remains blocked on the
  owner choosing Workers Paid or explicitly accepting the Free daily-quota risk.
- **Operator plane:** implement P01’s explicit protected-operator strategy
  (private kubectl/runbook or authenticated admin surface), define operator
  identity/authorization, and prove ordinary users cannot list, read, or resolve
  moderation reports.
- **Acceptance:** meets Apple Guideline 1.2 filtering, reporting, blocking,
  response, and contact requirements without leaking gameplay reporter identity
  or moderation information.
- **Evidence:** migrations; raw HTTP/real-Postgres authorization and privacy
  matrix; filter corpus/boundaries; rate-limit/idempotency tests; Wrangler dry-run,
  immutable Worker version and exact live route/binding configuration; bounded
  429 tests proving both edge and origin enforcement without locking out ordinary
  app flows; audit records. Architecture sources: [Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
  [WAF plan availability](https://developers.cloudflare.com/waf/), and
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
- **Apple source:** https://developer.apple.com/app-store/review/guidelines/

### P06 — UGC safety UX, consent, and user control — 5%

- **Status:** `NOT STARTED`
- **Dependencies:** P05, P07
- **Work:** report content/user to operator, block/unblock, easy leave, community
  rules/terms acknowledgement, support entry point, confirmations, safe errors,
  and clear consensual/private-group language.
- **Acceptance:** user can protect themselves from every relevant member/content
  surface; normal, empty, offline, duplicate, unauthorized, and failure states
  are honest and accessible.
- **Evidence:** Storybook, Playwright two-session browser flow, local
  accessibility/focus/target-size review, and independently reviewed screenshots.
  Physical two-device proof is P12.

### P07 — Genuine privacy, support, terms, and community pages — 6%

- **Status:** `NOT STARTED`
- **Dependencies:** P01, P09
- **Work:** publish Privacy Policy, Support, Terms, Community Guidelines, and
  optionally a dedicated Account Deletion page; link them from the app. Include
  effective date, collection/use, visibility, retention, deletion, UGC,
  reporting/moderation, and real support contact.
- **Acceptance:** Calum-approved pages are accurate, distinct, locally reachable
  without authentication, readable on phone/desktop, and not generic SPA
  fallbacks. Public production proof is P10.
- **Evidence:** local unique hashes/titles/content types and 200 responses for
  each route, link checker, mobile/desktop browser screenshots, in-app link tests.

### P08 — Operational moderation and support readiness — 4%

- **Status:** `NOT STARTED`
- **Dependencies:** P05, P07
- **Work:** protected operator queue or safe runbook; new-report notification;
  investigation/removal/block/resolve flow; moderation/support retention,
  backup, observability, and stated response target.
- **Acceptance:** operator authentication/runbook and an integration/synthetic
  local drill prove one report produces one non-PII alert, ordinary users have no
  operator access, and an authorized operator can resolve with an audit trail.
  The production alert/queue/backup drill is P10.
- **Evidence:** integration drill, redacted queue/audit capture, authorization
  tests, notification-adapter test, runbook, and local observability contract.

### P09 — Privacy data inventory and App Privacy answers — 5%

- **Status:** `NOT STARTED`
- **Dependencies:** P01, P03, P05
- **Work:** inventory every field, upload, log, SDK, network destination,
  retention rule, deletion rule, identity linkage, purpose, sharing, and
  tracking status. Map it to App Store Connect privacy taxonomy.
- **Privacy manifest:** audit the bundled `PrivacyInfo.xcprivacy`, required-reason
  API declarations, and privacy manifests/signatures for listed third-party SDKs
  including Capacitor; generate and review Xcode’s privacy report; fail on a
  missing or invalid manifest/signature.
- **Tracking/ATT:** if any first- or third-party data is used for tracking,
  implement AppTrackingTransparency and prohibit tracking before authorization.
  Otherwise prove no tracking through dependencies and current-runtime network
  behavior.
- **App Store fields:** privacy-policy URL is `APPLE REQUIRED`; privacy-choices
  URL is optional. Draft all selected first-/third-party data types here. Final
  RC reconciliation and Publish occur in P14/P15 because publishing is an
  accuracy/compliance attestation requiring `OWNER-ONLY` confirmation.
- **Acceptance:** declarations come from source/schema/dependency/runtime audit,
  not guesses; first- and third-party collection are included; “no tracking” is
  claimed only after dependency and current-runtime network verification.
- **Evidence:** reviewed source/schema/log/data-flow table, dependency and
  current-runtime network audit, draft exact App Privacy answer set, retention/
  deletion mappings, and manifest/required-reason audit. Final-RC network capture,
  saved/published App Privacy answers, and owner Publish attestation are P14/P15.
- **Apple source:** https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy
- **Additional Apple sources:**
  https://developer.apple.com/support/third-party-SDK-requirements/ and
  https://developer.apple.com/documentation/bundleresources/privacy-manifest-files

### P10 — Integrate, deploy, and prove compliance changes — 7%

- **Status:** `NOT STARTED`
- **Dependencies:** P02–P09 `PROVEN`
- **Work:** implementation tickets/worktrees/PRs, independent review, merge only
  green, `home-server` deployment, migrations, backup/restore, public routes,
  moderation drill, and repeat deployment.
- **Acceptance:** immutable SHA passes Postgres, unit, Storybook, Playwright,
  typecheck/Knip, image builds, security/policy tests, deploy and Cloudflare;
  production remains healthy with no temporary QA data.
- **Evidence:** PRs, immutable workflow IDs, deployment SHA/digests, rollout/CNPG
  status, migration list, public probes, backup and scratch restore, cleanup.
- **Integrated production additions:** prove P07 policy/support routes publicly;
  run P08’s production alert/queue/resolve/backup drill; verify moderation tables
  survive restore; prove the public hostname routes only the configured frontend
  and `/api` services through outbound-only Cloudflare Tunnel; exercise each
  Worker binding class and API-side limiter with safe bounded probes; confirm unrelated
  `worldwidewebb.co` hosts and legitimate app flows are unaffected; and remove
  synthetic data afterward.

### P11 — Final signed iOS release candidate, Build 25+ — 5%

- **Status:** `NOT STARTED`
- **Dependencies:** P10, P01 device-family decision
- **Work:** keep marketing version 1.0; monotonic build; final Capacitor sync;
  archive/sign; verify Sign in with Apple and AASA entitlements/profile; resolve
  export compliance; upload/process; distribute exact build through TestFlight.
- **Toolchain gate:** at build time, check Apple’s currently supported Xcode,
  SDK, validation, and upload requirements rather than relying on the historical
  pipeline configuration.
- **Privacy artifact gate:** inspect the archived binary for required app/SDK
  privacy manifests, required-reason declarations, and signatures; attach the
  reviewed Xcode privacy report to the evidence bundle.
- **Permission strings:** audit the actual WKWebView picker/camera paths and the
  archived Info.plist for `NSPhotoLibraryUsageDescription`,
  `NSCameraUsageDescription`, and other usage strings. Add only permissions the
  release uses; prove no physical picker/camera crash in P12.
- **Device-family gate:** inspect the archived app’s `UIDeviceFamily`. An
  iPhone-only release must equal `[1]`; a universal release must equal `[1,2]`
  and triggers real iPad layout/interaction QA plus 13-inch iPad assets.
- **Acceptance:** processed build is the exact immutable product SHA and later
  becomes the build attached to App Store version 1.0.
- **Evidence:** workflow URL/ID, build ID, signing/entitlement results, processed
  status and group assignment screenshots, honest What to Test metadata.

### P12 — Physical and external TestFlight release acceptance — 8%

- **Status:** `NOT STARTED`
- **Dependencies:** P11 and external Beta App Review eligibility
- **Work:** fresh non-team install over public internet; first/return Sign in
  with Apple; two users; create/join/invite; cold/warm universal link; picker and
  share sheet; slips; gameplay report; abuse report/block/leave; deletion and
  re-registration; offline/restart; VoiceOver, Dynamic Type, safe areas, touch;
  equivalent iPad checks if iPad remains supported.
- **Acceptance:** every V1/current-policy physical row is `PASS` or approved
  `N/A`; failures are fixed in a newer build and the exact replacement is retested.
- **Apple deletion proof:** perform real Sign in with Apple deletion/revocation
  without recording tokens, then verify old credentials fail and the approved
  re-registration semantics work.
- **Evidence:** redacted device/OS/build matrix, screenshots/recordings, TestFlight
  eligibility, API/DB/log correlation, independent tester signoff.
- **Classification:** external TestFlight/Beta App Review is a `PROJECT GATE` for
  this release’s physical QA, not an Apple prerequisite for submitting the same
  eligible build to public App Review. Build 24’s beta status must not stall
  independent engineering/listing work or be mistaken for App Store approval.

### P13 — App icon, launch experience, and store screenshot system — 9%

- **Status:** `NOT STARTED`
- **Dependencies:** final UI from P02/P04/P06; P01 device-family decision; P11;
  P12 physical/core-flow signoff
- **Work:** replace dollar-sign icon and default Capacitor splash; create safe
  deterministic fixture states; capture exact release UI; compose, verify, and
  independently review 5–7 store screenshots. Suggested repository layout:

  ```text
  apps/dont-text-your-ex/app-store/
    README.md
    copy/en-US.json
    fixtures/en-US.json
    raw/iphone-6.9/
    final/iphone-6.9/
    final/ipad-13/          # only if iPad remains supported
    review/contact-sheet.png
    manifest.json
    qa.json
    scripts/capture.ts
    scripts/compose.ts
    scripts/verify.ts
  ```

- **Recommended narrative:** Stay no-contact together; progress at a glance;
  private pact with friends; log without judgment; celebrate progress; resolve
  respectfully; privacy/control. The first three must explain the product.
- **Capture requirements:** use either the exact submitted-binary UI with a
  dedicated fictional account/data, or the same immutable release
  source/configuration with a screenshot-only seam proven compiled out of the
  submitted archive. Never ship `/auth/dev`, fixture routing, authentication
  bypass launch arguments, or active seeded invite codes. Use fictional names
  and data, fixed locale/time/status bar, and no debug/loading/keyboard/window
  chrome or real message screenshots. Do not imply message-reading or payments.
- **Dimensions:** use current Apple-accepted highest-resolution device classes
  verified at execution time and record the Apple-source retrieval date in the
  manifest. Apple currently permits the required iPhone set at a supported
  6.9-inch or 6.5-inch size; a 6.9-inch set can scale down when the UI is the
  same. Allow 6.9-inch portrait `1260×2736`, `1290×2796`, or `1320×2868`;
  recommend `1320×2868`. If universal, allow iPad 13-inch portrait `2064×2752`
  or `2048×2732`. Use one consistent size/orientation per localization and
  device set. A scaled iPhone composite is not iPad usability evidence.
- **Icon gate:** 1024×1024 RGB master, no alpha or pre-rounded corners; no `$`,
  text, third-party trademark, or implication of money transfer/message
  interception. Record artwork rights/provenance. Review at 16, 29, 40, 60, 76,
  120, 180, and 1024px on light/dark backgrounds, and verify installed-device,
  TestFlight, and App Store Connect consistency.
- **Launch gate:** static, product-matched launch content with no marketing text
  or fake loading UI. Verify every asset-catalog variant. Inspect a simulator and
  physical-device cold-launch video frame by frame for white flash, clipping,
  logo jump, or mismatch with the first app frame.
- **Acceptance:** 1–10 accurate app-in-use screenshots per required device class;
  not merely login/onboarding/splash. Require flattened sRGB/RGB, no alpha,
  exact dimensions/bytes, valid decode, and no unintended profile conversion.
  Record cryptographic hashes for provenance and perceptual-hash/difference
  thresholds for near-duplicate detection. Run a denylist scan for real seed
  names, emails/phones, Apple IDs, production invite codes, and private ex labels,
  plus human privacy review for avatars/embedded images. Fail on any real photo,
  message, notification, contact, active invite, or production identifier.
  Exclude unrelated platform logos/chrome and unsupported superlative, price,
  medical/therapy, automatic-detection, payment, or safety claims; overlays may
  explain real capability but cannot fabricate UI. Require correct ordering,
  contact sheet, original-size/thumbnail review, per-asset independent
  product/privacy/policy/polish signoff, successful App Store processing, and
  re-download/preview inspection of order, crop, legibility, and device class.
- **Invalidation:** `manifest.json` records the exact source SHA and build number.
  Any later UI, icon, launch, localization, fixture, font, or layout change
  invalidates P13 until all affected assets are regenerated and re-reviewed.
- **Apple sources:**
  https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications
  and https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots

### P14 — Listing, app-level setup, privacy, and reviewer package — 7%

- **Status:** `NOT STARTED`
- **Dependencies:** P01, P02, P07, P09, P13
- **Required version product page:** screenshots (1–10 per required device
  class), description (≤4,000 characters), keywords (≤100 bytes), Support URL,
  copyright, and version number. `What’s New` is not required/available for the
  first version.
- **Required app level:** app name (≤30 characters) and primary category.
- **Optional metadata:** subtitle (≤30 characters), promotional text (≤170),
  Marketing URL, secondary category, and app-preview video. Polish may promote
  selected optional fields to `PROJECT GATE`, but they are not Apple-required.
- **App-level:** Content Rights, age rating, DSA/trader status, regional
  compliance, App Privacy, encryption/export status. Accessibility Nutrition
  Labels are currently `RECOMMENDED/VOLUNTARY`; claim one only after all common
  tasks meet Apple’s criteria.
- **Commerce/availability:** price, tax category, storefronts, agreements; ensure
  no stale IAP/subscription state. The latest developer/free-app agreement is an
  Account Holder gate even for a free app; Paid Apps Agreement, banking, and tax
  forms are `CONDITIONAL` on charging/monetization. Apple’s standard EULA applies
  unless P01 deliberately chooses an optional custom EULA.
- **Reviewer package:** required contact name/email/phone and Notes (≤4,000
  bytes); for login-gated functionality provide stable non-expiring access and
  every resource needed for review. Never store/share an Apple ID password in
  the repo. Decide and test either reviewer Sign in with Apple using their own
  Apple ID plus a stable, non-sensitive second actor/invite, or a dedicated
  approved demo mechanism. Define its lifecycle/cleanup and prove it is not a
  production dev-auth or privacy bypass. A demo mode used instead of account
  access due to legal or security constraints may require prior Apple approval.
  Include exact two-user steps, live data, safety/deletion locations, and “no
  messages read / no money transferred.”
- **Acceptance:** copy limits/lint pass; prohibited-copy grep passes; all URLs
  pass; final-RC network capture matches P09; privacy answers are owner-confirmed
  and published; reviewer instructions are independently replayed on a clean device;
  every field is saved with redacted evidence; App Store Connect shows no
  required-field warning.
- **Optional dispositions:** record App Preview (expected `N/A` for V1), Marketing
  URL, iPad screenshots (`N/A` only for archived `UIDeviceFamily=[1]`), phased
  release (`N/A` for initial 1.0), and localization (en-US only unless P01 expands
  scope). Never silently omit them.
- **Apple sources:**
  https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information
  and https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating/

### P15 — Final pre-submission gate — 5%

- **Status:** `NOT STARTED`
- **Dependencies:** P11–P14
- **Acceptance checklist:**
  - [ ] Exact tested Build 25+ attached to version 1.0.
  - [ ] Production tests, policy tests, deployment, URLs, and final smoke green.
  - [ ] Account deletion and Apple revocation proven.
  - [ ] UGC filtering/reporting/blocking/contact/operations proven.
  - [ ] Physical two-device/external release-candidate suite passes.
  - [ ] Final icon, splash, screenshots, and listing independently reviewed.
  - [ ] Screenshot manifest SHA/build matches the attached App Store binary; no
        invalidating UI/asset change occurred afterward.
  - [ ] Privacy answers audited, owner-confirmed, and published.
  - [ ] Age rating is complete and not Unrated.
  - [ ] Content Rights, DSA, agreements, pricing, tax, territories, and export
        compliance resolved by the appropriate owner.
  - [ ] Selected initial-release mode matches P01’s owner decision; manual is a
        recommendation, not an Apple requirement.
  - [ ] Reviewer instructions independently replayed.
  - [ ] Backend and reviewer path are live and non-expiring for the review
        window, are not blocked by rate limits, and pass pre-submit access checks.
  - [ ] No App Store Connect missing-field/blocking warning.
  - [ ] Frozen release SHA/build and rollback/support plan recorded.
- **Evidence:** final acceptance report and redacted screenshots of Version, App
  Information, App Privacy, Pricing/Availability, and Review submission pages.
- **Boundary:** notify Calum with the complete evidence summary and obtain
  explicit approval immediately before external submission.

### P16 — Submit and complete the App Review loop — 3%

- **Status:** `NOT STARTED`
- **Dependencies:** P15, explicit submission approval
- **Work:** Add for Review; inspect draft submission; Submit for Review; capture
  timestamp/status; monitor messages; answer promptly. For rejection, map each
  issue to reproduction/evidence, fix forward, upload a new build if binary
  changes, retest, and resubmit.
- **During review:** run and record a daily public-backend and reviewer-access
  health check without personal data; notify immediately on failure.
- **Acceptance:** version 1.0 reaches Apple approval with no unresolved issue.
- **Evidence:** submission status/ID, redacted correspondence ledger, each issue’s
  fix SHA/build/fresh evidence, approval screenshot/status.
- **Apple sources:**
  https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app
  and https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/manage-a-submission-with-unresolved-issues

### P17 — Release and prove public App Store availability — 3%

- **Status:** `NOT STARTED`
- **Dependencies:** P16 approval, explicit approval if manual release
- **Work:** release using P01’s chosen mode; monitor propagation; verify intended
  storefronts; install from the public store using a device/account without
  TestFlight history; verify binary, Sign in with Apple, core two-user flow,
  policies, support/moderation, production health and error rates.
- **Acceptance:** status Ready for Distribution; public product page is logged-out
  reachable and correct; ordinary fresh download succeeds; installed version/build
  matches; production functionality and support paths work; no launch blocker.
- **Evidence:** public `apps.apple.com` URL/status, listing screenshots, storefront
  checks, fresh-install receipt/version/build, device flow, cluster/API/log health,
  final acceptance report and 100% ntfy notification.
- **Note:** phased release is not available for an initial version; it applies to
  updates. Manual release is recommended for controlled V1 launch.

## Owner decision ledger

| Decision | Status | Decision / evidence | Date |
|---|---|---|---|
| Final App Store name | DECIDED + SAVED | **Don’t Text Your Ex**; explicitly requested by Calum and saved successfully in App Store Connect. It remains subject to App Review and is not yet publicly distributed | 2026-08-16 |
| iPhone-only or iPhone+iPad | DECIDED | iPhone-only for V1; remove iPad from the final binary and record iPad screenshots as N/A | 2026-08-22 |
| Privacy/legal owner and support contact | DECIDED | Individual privacy/legal owner: **Calum Peter Webb**. No company is required. Publish **support@worldwidewebb.co** as the support contact; Calum will later configure private forwarding outside the repository | 2026-08-22 |
| Copyright | DECIDED | **2026 Calum Peter Webb** | 2026-08-22 |
| Account deletion/shared-data behavior | DECIDED | Immediate selective local erasure with deterministic active-member succession: shared jars survive when another active member remains; the active member with the lowest `(joined_at,id)` becomes owner; creator-authored jar text and the departing person's linked content are erased; invites rotate; sole-active-member jars are deleted; re-registration is fresh. Apple revocation is attempted from fresh authorization but cannot delay local erasure; failures retry durably and surface for manual action. No unspecified legal-retention exception was requested | 2026-08-22 |
| Moderation response target and escalation | DECIDED | Calum is the single V1 operator; urgent safety reports target 24 hours, ordinary reports 48 hours; unresolved/legally sensitive cases escalate to the public support path | 2026-08-22 |
| Price/tax/territories | DECIDED | Free; no IAP, ads, or real payments; App Store software tax category; all storefronts Apple makes available | 2026-08-22 |
| Primary/secondary category | DECIDED | Primary **Lifestyle**; secondary **Social Networking** | 2026-08-22 |
| Age/consent stance | DECIDED | Product minimum age 13+; complete Apple's questionnaire truthfully against the final UGC/social feature set | 2026-08-22 |
| DSA trader status | DECIDED — OWNER ATTESTED | **Non-trader**: Calum stated this is a personal project and he has no company. [Apple's current guidance](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements/) says a hobbyist acting outside a trade/business/profession with no intention to commercialize may not be a trader; the developer remains responsible for the self-assessment | 2026-08-22 |
| Content Rights | DECIDED — OWNER ATTESTED | Calum confirms that the app's code, text, images, and other content are his or appropriately licensed | 2026-08-23 |
| Release mode | DECIDED | Manual release after approval; phased release is N/A for initial V1 | 2026-08-22 |
| License agreement | DECIDED | Apple Standard License Agreement; no custom EULA | 2026-08-22 |
| Mac / Vision Pro availability | DECIDED | Disable both for V1; neither is represented as tested or supported | 2026-08-22 |
| Distribution method | DECIDED | Public/discoverable App Store distribution; disable School Manager reduced-price availability for V1 | 2026-08-22 |
| Protected moderation operator plane | DECIDED | Coordinator decision after `/root/p01_operator_plane` audit: private typed `moderationctl` + committed runbook in the existing API pod; no operator HTTP route/UI for V1 | 2026-08-16 |
| V1 moderation operator responsibility | DECIDED | Calum operates the typed runbook using the existing cluster-admin credential as the single V1 root of trust; no additional operator until a least-privilege plane exists | 2026-08-22 |
| Cloudflare API abuse-control architecture | DECIDED — DEPLOYMENT PLAN OPEN | Exact `/api/*` Worker route with five Rate Limiting API bindings plus independent origin client/user limits. This replaces zone WAF rules because the Free zone permits only one such rule and cannot express the required five budgets. Edge binding errors fail closed; origin controls remain independent. Workers Paid is recommended because Free stops after 100,000 requests/day; enabling billing or accepting that availability risk still requires Calum | 2026-08-23 |
| V1 localization | DECIDED | English (U.S.) only for V1 | 2026-08-22 |

## Evidence ledger

Append one row per proof event. Link repository artifacts with paths and external
evidence with stable URLs/IDs. “Observed” without a timestamp/source is invalid.

| Date/time | Packet | Scope | Result | Commit/build | Evidence | Reviewer |
|---|---|---|---|---|---|---|
| 2026-08-15 | P00 | Existing production restoration | PASS | `ecf47add2`, Build 24 | Restoration execution ledger; CI `31872702467` | Prior independent QA + coordinator |
| 2026-08-15 | P00 | Live App Store version baseline | PASS | Version 1.0 | Prepare for Submission; 0 screenshots; no build attached; blank visible metadata/review fields | Coordinator browser inspection |
| 2026-08-15 | P00 | Durable tracker | PASS | `T-41` | Verbatim request, source-of-truth path, and public completion boundary recorded | Coordinator |
| 2026-08-16T04:18:32Z | P00 | Repository, tracker, and current main gates | PASS | `f2426fdc8` | PR [#703](https://github.com/0x63616c/world-wide-webb/pull/703); main CI [31926173581](https://github.com/0x63616c/world-wide-webb/actions/runs/31926173581); CodeQL `31926173275`; `T-41` open; [redacted evidence](../evidence/dont-text-your-ex/p00-baseline-2026-08-16.md) | Engineering release audit + coordinator |
| 2026-08-16T04:17:52Z | P00 | Production, public edge, and AASA | PASS with recorded gaps | deployed pre-P00 images | [Machine/public evidence](../evidence/dont-text-your-ex/p00-baseline-2026-08-16.md); policy routes and `/version.json` proven SPA fallbacks | Production/public audit + coordinator |
| 2026-08-16T04:19:55Z | P00 | Live Apple release state | PASS | Version 1.0; Build 24 | [Redacted UI-state evidence](../evidence/dont-text-your-ex/p00-baseline-2026-08-16.md); [public TestFlight link](https://testflight.apple.com/join/6HcbUuV3) | Coordinator browser inspection + independent screenshot review |
| 2026-08-16T04:26:49Z | P00 | Durable baseline merge and review closure | PASS | `676623f18` | PR [#705](https://github.com/0x63616c/world-wide-webb/pull/705); all checks green; standards/spec review findings corrected before merge | Independent standards/spec reviewers + coordinator |
| 2026-08-16T05:32:05Z | P02 | Dependency-safe implementation review | LOCAL PROOF PASS; PR/CI/DEPLOY PENDING | `b3dfeccdd` | Supportive copy, split-copy/payment/currency safeguards, legacy-row compatibility, and neutral internal terminology independently re-reviewed with no remaining code/spec findings. Frontend 41/41; relevant Storybook 55/55; real-Postgres Playwright 20/20 in 44.8s; all 14 changed-screen frames plus the six representative captures independently reviewed at original resolution with no defects or sensitive data. P02 remains dependency-gated by P01 | Independent standards/spec reviewers + independent original-resolution screenshot reviewer + coordinator |
| 2026-08-16T05:53:21Z | P02 | Merge, interim iOS build, home-server deployment, and public edge | PASS; DEPENDENCY GATE REMAINS | `647757a50`, Build 25 | PR [#709](https://github.com/0x63616c/world-wide-webb/pull/709); main CI/deploy [31929697174](https://github.com/0x63616c/world-wide-webb/actions/runs/31929697174); iOS upload [31929697178](https://github.com/0x63616c/world-wide-webb/actions/runs/31929697178). Namespace deployments and CNPG were ready; public `/` and `/api/health` returned HTTP 200; health body SHA-256 `4062edaf…` was `{"ok":true}`; shipped bundle SHA-256 `f39526fc…` contained the supportive reset/accountability/no-money strings and none of the scoped legacy shame/payment strings. Build 25 is interim TestFlight evidence, not the final compliance RC. P02 remains dependency-gated by P01 | Main CI + coordinator public/cluster verification |
| 2026-08-16T04:35:42Z | P01 | Requested App Store name | PASS — saved, not reviewed | App `6778544752` | [Saved name and current setup evidence](../evidence/dont-text-your-ex/p01-app-store-state-2026-08-16.md) and [cropped capture](../evidence/dont-text-your-ex/assets/p01-app-name-saved-2026-08-16.png), SHA-256 `3cd3ce07…`; remains subject to App Review | Coordinator + `/root/p01_name_screenshot_review` |
| 2026-08-16 | P01 | Deletion and operator-plane decision analysis | PASS / OWNER CONFIRMATION OPEN | current schema/infrastructure | [Schema-aware decision analysis](../evidence/dont-text-your-ex/p01-decision-analysis-2026-08-16.md); operator architecture decided by coordinator after `/root/p01_operator_plane`; deletion consequences and operator responsibility await Calum after `/root/p01_deletion_decision` | Named audit agents + coordinator |
| 2026-08-16 | P01/P03 | Temporal delivery reconciliation | PASS / OWNER CONFIRMATION OPEN | T-42 coordinator branch | [Temporal orchestration ADR](../adr/0014-dont-text-your-ex-temporal-orchestration.md) and [account-deletion data map](../../apps/dont-text-your-ex/docs/account-deletion-data-map.md) record the incompatible shared-jar and Apple-order proposals; W01/W02 may proceed, W10 destructive work may not | `/root/runtime_design`, `/root/outbox_workflows`, coordinator |
| 2026-08-22 | P01 | Recommended release defaults and legal identity | OWNER APPROVAL RECORDED; ONE FIELD OPEN | `2940b01cd` baseline | Calum approved the recommended release defaults, identified the project as personal/non-commercial with no company, supplied the individual legal/privacy-owner name **Calum Peter Webb**, and approved **support@worldwidewebb.co** as the public support contact. The private forwarding destination is intentionally not recorded in the public repository. The deletion conflict is resolved in favor of active-member succession plus immediate local erasure with durable Apple retry. Only the Content Rights attestation remains open | Calum + coordinator; DSA wording checked against current Apple guidance |
| 2026-08-23T16:48:33Z | P01/P02 | Final owner attestation and dependency closure | PASS — BOTH PACKETS PROVEN | `8b28d1ff2` branch baseline | Calum confirmed all app code, text, images, and other content are owned or appropriately licensed. This closes the final P01 field and satisfies P02's only dependency; P02's merged implementation, immutable CI, production deployment, public probes, and independently reviewed 20-image evidence set remain valid | Calum + coordinator |
| 2026-08-23T20:12:41Z | P05 | Local UGC safety, moderation, abuse controls, and network hardening | LOCAL PROOF PASS; PR/CI/DEPLOY/PHYSICAL PENDING | local image `sha256:b19b8741…` | Fresh PostgreSQL migration chain through `0021`; API 215/215, frontend 48/48, infrastructure 445/445, Cloudflare 32/32, edge 13/13; exact five-binding Wrangler dry-run; Talos metal validation; all eight frozen-install manifests; production API image build. Independent combined review found no remaining P0/P1 defect. This does not claim live Cloudflare, Kubernetes policy enforcement, physical-device evidence, or P05 completion | Independent standards/spec reviewers + coordinator |
| 2026-08-23T20:32:25Z | P03/P05 | Formal review closure and combined serial acceptance | LOCAL PROOF PASS; PR/CI/DEPLOY/PHYSICAL PENDING | P05 `7cecdaa15`; integration `116c7da21` | Formal Standards review reports no hard gap and formal Spec review reports no P0/P1 defect. On an isolated PostgreSQL instance, the combined branch passed API 277/277 and then Temporal worker 130/130 serially; frontend 49/49, focused infrastructure 12/12, Cloudflare 32/32, and edge Worker 13/13 also passed. The Worker dry-run exposed the exact five rate-limit bindings. The account-deletion suite proves full abuse-report and audit erasure when the deleted account is either participant while unrelated moderation data survives. No production mutation is claimed | Independent Standards, Spec, and combined-integration reviewers + coordinator |
| 2026-08-23 | Operations | Temporal worker production repair | PASS | PR [#713](https://github.com/0x63616c/world-wide-webb/pull/713), `e710e1378` | Main CI [32598528985](https://github.com/0x63616c/world-wide-webb/actions/runs/32598528985) passed; live `dont-text-your-ex` deployment and pod were ready 1/1 with zero restarts after the runtime-image fix | Coordinator live cluster verification |
| 2026-08-23 | P05 | Talos NetworkPolicy enforcement configuration | LOCAL CONFIG PASS; LIVE APPLY/PROBES PENDING | P05 working tree | Talos source now enables `cluster.network.cni.flannel.kubeNetworkPoliciesEnabled`; encrypted-secret render plus `talosctl validate --mode metal` passed. The live cluster had zero NetworkPolicy objects before this work. No Talos or Kubernetes production mutation has been made; approved maintenance-window apply, bootstrap-manifest sync, and allowed/denied live probes remain | Coordinator + infrastructure implementation reviewer |

## Blocker ledger

| Opened | Packet | Blocker | Owner | Next action | Status |
|---|---|---|---|---|---|
| 2026-08-15 | P01 | Owner/legal/product decisions not yet recorded | Calum | None; all owner decisions are recorded | RESOLVED 2026-08-23 |
| 2026-08-23 | P03 | Production Sign in with Apple revocation key is not provisioned | Calum + coordinator | Calum signs into Apple Developer and completes 2FA; coordinator prepares the key and asks immediately before final generation/download | OPEN; local P05 work continues |
| 2026-08-23 | P05 | Cloudflare Free Workers quota permits an attacker-triggered edge outage even though the origin stays protected | Calum | Approve Workers Paid (recommended, approximately USD 5/month minimum) or explicitly accept the Free-tier availability risk before edge deployment | OPEN; implementation/testing continues |
| 2026-08-23 | P05 | Talos Flannel does not yet enforce Kubernetes NetworkPolicy on the live cluster | Calum + coordinator | Approve a maintenance-window machine-config apply; synchronize bootstrap manifests and run live allowed/denied traffic probes | OPEN; config renders and validates locally |

## Notification ledger

| Date/time | Percent | Milestone | Event ID | Blockers / remaining |
|---|---:|---|---|---|
| 2026-08-15 | 2% | Control-document phase started | `KmPxBhNk5S6G` | Sent before packet-weight formula; earned progress was 0%. Correct in the next notification. |
| 2026-08-15 | 0% | Control document merged; P00 refresh started | `XoGDGDjQvfOC` | Corrected earned progress; no P00 blocker; baseline refresh remained. |
| 2026-08-16T04:26:59Z | 5% | P00 baseline proven and merged | `zPExehUPLTnr` | P01 owner decisions are next; compliance, RC, physical QA, listing, submission, approval, and public proof remain. |
| 2026-08-16T05:17:08Z | 5% | P02 implementation/review update; no earned-progress change | `KVx7azibmFNU` | Review findings were fixed; the four initially rejected captures were subsequently corrected, recaptured, and passed. P01 owner/legal decisions still gate P02 and earned progress. |
| 2026-08-16T05:53:40Z | 5% | P02 merged, deployed publicly, and uploaded as interim Build 25; no earned-progress change | `oWCgVOw5YMLK` | P01 owner/legal decisions still gate P02. Account deletion, UGC safety, legal pages, final RC, physical QA, listing, submission, approval, and public App Store proof remain. |
| 2026-08-23T16:48:33Z | 13% | P01 owner decisions and P02 supportive positioning proven | `cajXUWRyze2w` | P03 account deletion is in progress. UGC safety, edge/API abuse controls, legal pages, final RC, physical QA, listing, submission, approval, and public proof remain. |
| 2026-08-23T19:37:33Z | 13% | P05 local hardening implementation in progress; no earned-progress change | `QJvQ1MyUqYkP` | Origin limiter, moderation intake, safe evidence pipeline, edge Worker, API NetworkPolicy, and Talos enforcement configuration are under combined verification. Apple Developer login/2FA, Cloudflare plan choice, and approved Talos rollout remain. |
| 2026-08-23T20:12:41Z | 13% | P05 local implementation and independent closure review pass; no earned-progress change | `aFdvt3le35z8` | Fresh/full local gates pass with no remaining P0/P1 code defect. PR/CI, production deployment, live edge/origin probes, Talos policy enforcement, iPhone evidence QA, and P06 UX remain; owner blockers are unchanged. |
| 2026-08-23T20:32:25Z | 13% | P05 formal review and combined P03/P05 serial acceptance pass; no earned-progress change | `dp5Hceaf1qVe` | PR/immutable CI, production deployment, live edge/origin probes, Talos enforcement, iPhone evidence QA, P06 UX, listing, submission, approval, and public release proof remain. Apple login/2FA, Cloudflare plan choice, and Talos maintenance approval are unchanged. |

## Current status

- **Calculated progress:** 13% (`P00`, `P01`, and `P02` proven).
- **Current packets:** P03 and P05 in parallel.
- **Current blockers:** P03 production Apple revocation credentials require a
  signed-in Apple Developer session and 2FA. P05 production edge deployment
  requires the Workers Paid-versus-Free availability decision; live
  NetworkPolicy enforcement requires an approved Talos maintenance-window
  rollout. The public support address is `support@worldwidewebb.co`; its private
  forwarding destination is deliberately excluded from repository evidence.
  Build 25 remains an interim TestFlight build, not the final compliance release
  candidate.
- **Next action:** push/open the P05 pull request and prove immutable CI while
  awaiting the P03 Apple login; do not merge or deploy either packet until its
  production prerequisites are satisfied.
