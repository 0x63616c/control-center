# P03 account-deletion evidence

Captured on 2026-08-23 from the P03 implementation worktree. This packet proves
the local domain, API, Postgres, outbox, Temporal, notification-fencing, restore,
and UI behavior described below. It does not claim merge-SHA CI, production
deployment, real Apple-token revocation, TestFlight, or physical-device proof.

## Verification matrix

| Scope | Result |
|---|---|
| API unit and real-Postgres suite | PASS — 18 files, 159 tests |
| Temporal worker unit, real-Postgres, and real Temporal suite | PASS — 36 files, 130 tests |
| Frontend unit suite | PASS — 11 files, 47 tests |
| Profile Storybook browser suite | PASS — 3 tests in Chromium |
| Notifications package | PASS — 5 files, 15 tests |
| Platform metrics and environment manifests | PASS — 2 files, 17 tests |
| Don’t Text Your Ex infrastructure and observability | PASS — 2 files, 8 tests |
| API, frontend, worker, notifications, platform, and infrastructure typechecks | PASS |
| Frontend production build and Capacitor iOS sync | PASS |
| Fastlane release entitlements and metadata checks | PASS — 4 and 3 checks |
| Unsigned iOS simulator build | PASS — `BUILD SUCCEEDED` |
| Independent standards and specification re-review | PASS — no hard gaps |

The real Temporal integration uses the product namespace and task queue contract,
whose queue name is exactly `main`. The end-to-end tracer runs the real Postgres
store, domain transaction/outbox, dispatcher, Temporal worker and workflow, and
proves that an accepted request reaches terminal `complete` with the account
removed and its outbox event acknowledged. Apple is deliberately an injected fake
in this local tracer; real credential and token revocation belong to P12.

## Redacted before/after inventory

The real-Postgres owner/shared-jar matrix seeds one deleting identity plus an
unrelated identity. After local erasure, the following deleting-person rows move
from one to zero: user, OTP, membership, membership tenure, streak achievement,
notification preference, push device, rescue intervention, authored slip, abuse
report, report evidence, activity, and the two notifications derived from the
deleted report/activity. Auth sessions are revoked as part of deletion acceptance.

The shared jar remains one-to-one and is transferred to the deterministic earliest
active successor. Its private name and rule are sanitized, its creator reference is
cleared, and its invite identity rotates. A remaining friend-authored report slip
remains one-to-one while its private note, ex label, and deleted reporter reference
are cleared. The unrelated user, jar, membership tenure, streak achievement,
notification preference, push device, and rescue intervention all remain one-to-one.

The matrix separately covers active members, former members, closed jars,
concurrent mutations, transaction rollback, repeated deletion, stale session
rejection, Apple revocation success/already-revoked/transient retry behavior, and
fresh re-registration as a new empty identity.

## Temporal and delivery race boundaries

- A shared account-mutation advisory lock serializes deletion acceptance against
  in-flight mutations and prevents stale authenticated writes afterward.
- APNs delivery holds the same shared account fence across the bounded send and
  outcome write; deletion waits for an in-flight send, and later sends suppress.
- Workflow dispatch holds a per-workflow shared fence across the final cleanup
  manifest check and Temporal RPC; cleanup takes the exclusive fence.
- Local erasure refreshes the cleanup manifest while associated rows are locked,
  and the workflow performs a second termination sweep after erasure.
- An alert fires if local erasure has not completed within 15 minutes, with an
  operator runbook linked from the alert annotation.

## Restore and retention proof

The deletion journal is signed and pseudonymized with versioned keyrings. A
durable write-ahead intent closes the cross-store crash window: restore replay
honors a signed intent whether a crash lands immediately before or after the
database commit, while a normal observed rollback discards it. Tests prove intent
staging/promotion/discard, tamper rejection, restore replay, crash-retry duplicate
handling, and rollback reconciliation against Postgres.
Operational deletion rows and journals are purged only after retention has elapsed
and every inventoried Temporal history has been deleted. A live isolated restore
rehearsal and production key availability remain deployment proof obligations.

## UI capture

- Story: `don-t-text-your-ex-flows-profile--idle-profile`
- Viewport requested: `390 x 844`
- Saved image: [`profile-account-deletion-confirmation.png`](profile-account-deletion-confirmation.png)
- Saved image dimensions: `384 x 831` after Storybook chrome and scrollbar allocation

The reviewed flow exposes **Delete account** in Profile, explains shared- and
sole-member-jar consequences, and requires an irreversible acknowledgement before
the destructive action becomes available. The fresh Sign in with Apple path sends
the authorization code, identity token, and nonce together; the API verifies the
nonce and exact Apple subject before accepting deletion. The encrypted expected
subject travels only with revocation material, and the worker verifies that the
signed identity token returned by Apple’s code exchange has that same subject
before saving or revoking the refresh token.

Visual review passed for destructive affordance, hierarchy, spacing, visible
consequence copy, and disabled-state distinction. The narrow capture has a small
horizontal scrollbar because the Storybook fixture forces a 390 px wrapper into a
384 px content viewport; the app section itself is 344 px wide and this is not
production-device overflow evidence.

## Remaining proof boundary

P03 remains `IN PROGRESS` until this reviewed change is merged, passes immutable
merge-SHA CI, deploys to the `DontTextYourEx` production namespace, and is verified
against the live database, Temporal namespace, public API, and monitoring. The
production secret manifest currently lacks the dedicated Sign in with Apple key ID
and private key content required for Apple revocation. These values must be created
in Apple Developer, stored encrypted without entering chat or repository evidence,
and proven only by presence and live behavior.
