# Don’t Text Your Ex — V1 Release Acceptance

This document is the durable product-completion contract for the restoration.
Agents must read it together with
[`dont-text-your-ex-restoration.md`](./dont-text-your-ex-restoration.md) and keep
evidence current in
[`dont-text-your-ex-restoration-progress.md`](./dont-text-your-ex-restoration-progress.md).

The restoration is not complete merely because the old source builds or the
infrastructure deploys. It must be a usable v1 product: all recovered core flows
implemented honestly, obvious design and mobile-QA defects fixed, deployed to
production, and proven through a real external TestFlight user.

## Locked identity and production target

- Source: `products/text-your-ex` at commit `486a0ebbc`
- Current app path: `apps/dont-text-your-ex`
- Product name: **Don’t Text Your Ex**
- Apple bundle ID: `co.worldwidewebb.textyourex`
- Public host: `https://dont-text-your-ex.worldwidewebb.co`
- Kubernetes namespace: `dont-text-your-ex`
- Production cluster and Pulumi stack: `home-server`
- Progress and completion notifications: `ntfy.sh/0x63616c`, including a
  percentage and an honest statement of what remains

## Product sources of truth

Review implementation against all of these rather than relying on memory:

1. This v1 acceptance document.
2. The restoration/deployment plan.
3. `apps/dont-text-your-ex/docs/superpowers/specs/2026-06-07-text-your-ex-design.md`.
4. The recovered `apps/dont-text-your-ex/docs/design-reference/` material.
5. Current schemas, contracts, UI, and browser tests—used as evidence, not as a
   substitute for the product requirements above.

If code and design disagree, resolve the discrepancy explicitly. Do not silently
delete a user capability to make a test or repository rule pass.

## V1 capability acceptance

### Authentication and account

- [ ] Sign in with Apple works on a physical iPhone against production.
- [ ] Apple issuer, audience, signature, nonce, and state are validated.
- [ ] A returning Apple user can authenticate when Apple omits `fullName`.
- [ ] A new user who has no Apple-provided name can enter their own name; the app
  never invents one.
- [ ] Development authentication is unavailable in production.
- [ ] Session creation, persistence, expiry, and logout/revocation work.
- [ ] First-run onboarding and later profile/avatar editing work.

### Jars, invitations, and membership

- [ ] An empty account has a useful empty state.
- [ ] A user can create a jar.
- [ ] A user can copy/share an invitation and complete the invite screen.
- [ ] A second user can join through a valid invitation.
- [ ] Invalid, expired, or unauthorized join attempts fail clearly.
- [ ] Jar membership and data are isolated from non-members.
- [ ] A user can navigate back to their jar after creation/invitation.

### Slips and accountability

- [ ] A member can log a slip with required validation.
- [ ] The target member can confirm or deny a slip.
- [ ] Confirmed/denied state is durable and visible in the relevant activity and
  detail views.
- [ ] Authorization prevents unrelated users from mutating slips.

### Reports and evidence

- [ ] A member can report another member by note, screenshot evidence, or both.
- [ ] Reports enforce the note-or-image invariant in the UI, shared contract, and
  API.
- [ ] Real PNG, JPEG, and WebP screenshots can be chosen through the browser or
  iOS WebView file picker.
- [ ] At most three images are accepted, each at most 2 MiB.
- [ ] MIME type, file signature, count, and size are validated on both client and
  server boundaries.
- [ ] Evidence is persisted durably in Postgres and included in production
  backups.
- [ ] Real thumbnails and full evidence can be viewed; no fake camera-roll or
  placeholder evidence reaches production.
- [ ] Anonymous reporting hides reporter identity from ordinary product views
  while preserving correct authorization and audit data.
- [ ] Report outcomes and evidence threads remain usable after reload/restart.

### Lifecycle and activity

- [ ] Home and activity views work for empty and populated accounts.
- [ ] Core actions are reachable from the expected screens with no dead ends.
- [ ] The settle/close-jar flow works and leaves durable, understandable state.
- [ ] Loading, error, validation, offline, session-expired, and empty states are
  honest and recoverable.

## Basic QA release gate

Before production release, audit the current product against the recovered design
and test it at mobile dimensions. Fix, do not waive, obvious blockers such as:

- controls hidden behind decorative overlays or unable to receive pointer input;
- buttons that navigate nowhere or leave a user trapped;
- ambiguous accessible names or strict-mode duplicate targets;
- impossible or untyped route/identifier states;
- client-only validation with no server boundary enforcement;
- fake/placeholder data entering normal production flows;
- actions shown to users who are not authorized to perform them;
- empty/error/loading states that look like successful data;
- data that disappears after refresh, pod restart, or redeployment;
- layouts clipped or unusable on the supported iPhone/TestFlight surface.

### Feature-by-feature QA protocol

Every capability in **V1 capability acceptance** must be QAed individually. A
single broad end-to-end pass does not prove all of the feature's states or
boundaries.

For each feature, the execution ledger must record:

1. The responsible implementation agent and an independent QA/review agent.
2. The design or product requirement that defines the expected behavior.
3. Automated evidence at the narrowest useful layer: contract, API integration,
   component/Storybook interaction, browser flow, or native build test.
4. Hands-on QA of the normal path plus relevant empty, validation, authorization,
   failure, reload, and mobile-layout states.
5. Any defect found, its fixing commit, and the fresh evidence collected after
   the fix.
6. A final `pass`, `blocked`, or `not applicable` result. `Blocked` is not a
   release pass, and `not applicable` requires an explicit reason.

Implementation and QA should use separate agents wherever capacity permits.
When one agent must cover both, the feature still requires a fresh independent
review before release. No feature checkbox may be checked from source inspection
alone.

Required evidence:

- [ ] Every v1 feature has an individual QA row and final result in the execution
  ledger.
- [ ] Every release-blocking defect found during feature QA is fixed and retested.
- [ ] Design-to-implementation feature audit with no unresolved v1 blocker.
- [ ] Storybook states for major flows and shared product primitives.
- [ ] Real Postgres contract tests.
- [ ] Full Playwright flow suite using genuine pointer interactions.
- [ ] iOS simulator build.
- [ ] Physical iPhone smoke test over cellular/public internet.
- [ ] Fresh external TestFlight install by a non-team Apple ID.

## Production and operability acceptance

- [ ] PR checks pass at the immutable merge SHA.
- [ ] Merge deploys the `home-server` Pulumi stack successfully.
- [ ] Frontend, API, and CNPG resources are healthy in namespace
  `dont-text-your-ex`.
- [ ] Public DNS and TLS work.
- [ ] `/` reaches the production frontend and `/api/*` reaches the production API.
- [ ] Migrations apply successfully.
- [ ] A real write survives API and database pod restarts.
- [ ] A backup succeeds and restoreability is proven from the created artifact.
- [ ] A second deployment succeeds without manual recovery.
- [ ] Observability and health/readiness signals identify failures accurately.

## TestFlight release acceptance

- [ ] A signed build using bundle ID `co.worldwidewebb.textyourex` is uploaded to
  the existing App Store Connect app.
- [ ] The build finishes processing and is assigned to the intended testing
  groups.
- [ ] An external **Friends** group exists.
- [ ] Beta App Review is completed if Apple requires it.
- [ ] A public TestFlight link is enabled when appropriate.
- [ ] A non-development-team Apple ID installs, launches, signs in, and exercises
  the core v1 flow over the public production endpoint.

## Definition of v1 done

V1 is done only when every checkbox above is either proven or superseded by an
explicit user decision recorded in the execution ledger. There must be no known
red CI, no unresolved release-blocking design/QA finding, no unverified production
claim, and no completion notification sent early.

The final `ntfy.sh/0x63616c` notification must state 100%, the production URL,
the TestFlight result, and where the durable evidence is recorded.
