# Don’t Text Your Ex Temporal workflow delivery contract

**Status:** Implementation goal active; W01 is implemented pending live proof;
W00, W02, W03, and W09 are in progress<br>
**Tickets:** planning T-40; delivery T-42<br>
**Baseline:** `origin/main` at `3b4697e37bdd451a279864c1005f7284ea2fdebc` on 2026-08-16<br>
**Product:** `apps/dont-text-your-ex`<br>
**Production:** Pulumi stack `home-server`, Kubernetes namespace `dont-text-your-ex`<br>
**Temporal namespace:** `dont-text-your-ex`<br>
**Temporal task queue:** `main` — exact spelling, fixed by the requester

This document is the durable execution and acceptance contract for adding every
agreed Temporal workflow to Don’t Text Your Ex, shipping the supporting product
features, and proving them in production. It is intentionally sufficient to
resume the work after conversation compaction or in another agent session.

## Requested outcome

Deliver all of the following as working product capabilities, not prototypes:

1. A product-owned Temporal runtime and declarative schedule registry.
2. Transactional domain events and recoverable Temporal dispatch.
3. Native push registration and durable notification delivery.
4. Report accountability, reminders, and expiry.
5. A “Don’t Send It” urge-rescue experience.
6. Streak milestone notifications.
7. Monthly jar recaps.
8. Invite-expiry reminders.
9. Expired-session maintenance.
10. In-app account deletion, Sign in with Apple revocation, data erasure, and
    deletion-history cleanup for App Store compliance.
11. Tests, observability, migration/rollback, deployment, TestFlight, and live
    acceptance evidence for the complete system.

“Done” means merged to `main`, deployed to `home-server`, healthy, and verified
through real production and iPhone flows. A design, green local tests, a built
image, a processed TestFlight build, or a visible Temporal execution is not by
itself completion.

## Verified baseline and prior-work reconciliation

Don’t Text Your Ex currently has no Temporal workflows. Its Hono routes call a
Postgres-backed store, and the important jar, slip, tally, membership, and report
mutations are synchronous transactions. That transactional behavior remains the
authoritative domain state.

Control Center already has a Node Temporal worker, a feature-codegen registry,
schedule reconciliation, health checks, and retention-purge workflows. Don’t
Text Your Ex is an independently deployed Product and does not register as a
Control Center `features/*` App. It must not add its workflows to the Control
Center worker or mount its database credentials there.

The requester’s remembered “delete/compliance workflow” was traced to the App
Store release-control plan. That plan merged through PR #703 as commit
`f2426fdc8957b9409d1c0a0efb97e6dfd9fbbfe1` and now lives at
`docs/plans/dont-text-your-ex-app-store-release-control.md`. Its deletion packets
are explicitly `NOT STARTED`; it contains no account-deletion implementation.
This contract implements and proves those deletion packets without claiming the
rest of that broader public-App-Store plan is complete.

The unrelated deletion of abandoned `agent-runtime` lab namespaces was a cluster
cleanup and is explicitly outside this project.

Current deletion hazards that must be fixed rather than worked around:

- `origin/main` has no delete-account contract, route, store operation, or UI.
- Logout revokes only one local session.
- Native Sign in with Apple observes whether an authorization code exists but
  does not return it, exchange it, or retain a refresh token for later revocation.
- Current foreign keys can cascade deletion of a user-owned jar into other
  members’ memberships, slips, reports, evidence, and history.
- Several activity/reporting references would instead dangle or block deletion.
- Dated Postgres dumps are written to NFS with no declared retention purge.
- Existing Control Center purge workflows do not touch Don’t Text Your Ex data.
- Removing a Temporal Schedule definition is not the same as deleting workflow
  execution history and is not the same as deleting a user account.

Official Apple guidance used by this contract:

- [Offering account deletion in your app](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [App Review Guidelines 5.1.1(v)](https://developer.apple.com/app-store/review/guidelines/)
- [TN3194: Handling account deletions and revoking tokens for Sign in with Apple](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple)
- [Sign in with Apple token revocation](https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens)

These sources require in-app initiation of full account deletion for an app that
creates accounts, deletion of associated user-generated content unless retention
is legally required, and Sign in with Apple token revocation. This document does
not make broader legal-compliance claims; legal retention decisions remain the
owner’s responsibility.

## Fixed architecture

### Runtime isolation

- Reuse the existing self-hosted Temporal cluster and frontend service.
- Register a Temporal namespace named `dont-text-your-ex`.
- Every Don’t Text Your Ex workflow and schedule uses task queue exactly `main`.
- Isolation comes from the Temporal namespace, not a custom task-queue name.
- Build a product-owned Node worker image named
  `www-dont-text-your-ex-temporal-worker`.
- Run that worker in Kubernetes namespace `dont-text-your-ex`, beside the API and
  its CNPG database credentials.
- Do not restore the historical generic multi-product framework and do not make
  Don’t Text Your Ex a Control Center feature.

### Source-of-truth seam

Postgres owns business truth. Temporal owns durable orchestration around time,
retries, signals, unreliable external effects, and multi-step cleanup.

```text
iPhone command
  -> Hono route + Zod contract
  -> one Postgres transaction
       -> authoritative domain rows
       -> append-only domain_event row
  -> best-effort immediate dispatch
  -> Temporal namespace dont-text-your-ex / task queue main
       -> deterministic workflow
       -> idempotent activities
       -> Postgres / APNs / Apple

managed recovery schedule
  -> drains any domain_event rows missed during Temporal/API outages
```

The external interface of the orchestration module is a small typed domain-event
interface. Routes and the domain store do not know workflow type strings,
workflow IDs, task queues, timers, retry policies, Temporal clients, or APNs
failure classes.

### Payload and privacy rule

Workflow inputs, results, memo, search attributes, workflow IDs, and signal
arguments contain opaque identifiers and schema versions only. They never contain:

- names, Apple subjects, identity tokens, authorization codes, refresh tokens,
  access tokens, session tokens, or APNs device tokens;
- invite codes or invite URLs;
- private ex labels, report notes, rescue drafts, or other authored text;
- avatars, evidence images, data URLs, notification bodies, or screenshots.

Activities reload authorized current state immediately before acting. Logs,
metrics, tests, and evidence follow the same privacy rule.

### Workflow conventions

- Every workflow and activity takes exactly one object argument and returns one
  object value.
- Names come from typed registries rather than scattered strings.
- Workflow IDs are stable and make duplicate starts harmless.
- Every externally visible activity is idempotent under retries and
  crash-after-side-effect ambiguity.
- Workflow code performs no database, filesystem, environment, random, network,
  or host-clock I/O.
- Long-running/batch workflows continue as new before histories become large.
- Workflow exports remain available while any open or retained history can
  reference them.

### Workflow and schedule registry

Names below are the initial compatibility contract. Changing one after an
execution exists requires replay/version review, not a mechanical rename.

| Workflow type | Trigger | Stable workflow ID | Terminal result |
|---|---|---|---|
| `DtyeHealthCheckWorkflow` | `dtye_health` Schedule | Temporal Schedule action ID | Health activity completed or failed |
| `OutboxDispatchRecoveryWorkflow` | `dtye_outbox_recovery` Schedule | Temporal Schedule action ID | Bounded page drained |
| `NotificationDeliveryWorkflow` | Notification domain event | `notification/<opaque notification ID>` | Delivered, skipped, or permanent failure per device |
| `ReportAccountabilityWorkflow` | `report.created` | `report/<opaque report ID>` | Owned, denied, expired, closed, or departed |
| `UrgeRescueWorkflow` | Intervention creation | `rescue/<opaque intervention ID>` | Safe, slipped, or abandoned |
| `StreakMilestoneSweepWorkflow` | `dtye_streak_sweep` Schedule | Temporal Schedule action ID | Due local-time page processed |
| `MonthlyJarRecapWorkflow` | `dtye_monthly_recap` Schedule | `recap/<calendar month>/<opaque page ID>` | Eligible jar snapshots created |
| `InviteLifecycleWorkflow` | Jar creation/invite rotation | `invite/<opaque invite-version ID>` | Reminded, superseded, closed, or expired |
| `SessionMaintenanceWorkflow` | `dtye_session_maintenance` Schedule | Temporal Schedule action ID | Expired-session batches deleted |
| `AccountDeletionWorkflow` | Accepted deletion request | `deletion/<opaque deletion-request ID>` | Erased plus Apple outcome recorded |
| `DeletionHistorySweepWorkflow` | `dtye_deletion_history_sweep` Schedule | Temporal Schedule action ID | Eligible account-associated histories deleted |

Every listed workflow polls task queue `main` in Temporal namespace
`dont-text-your-ex`. Schedule IDs begin `dtye_`; boot reconciliation may delete
only undeclared Schedule definitions with that prefix.

## Proposed product defaults

These are the implementation defaults unless Calum changes them before starting
the dependent packet:

| Decision | Default |
|---|---|
| Temporal namespace retention | 90 days |
| Report reminders | Immediately, 24 hours, and 72 hours |
| Pending report expiry | Seven days; add terminal `expired` status |
| Existing pending reports | Backfill from original `created_at`; expire old ones without stale reminders |
| Rescue cooldown | Ten minutes |
| Rescue extension | Up to two ten-minute extensions; 30-minute total maximum |
| Rescue visibility | Private; no accountability-friend notification in this delivery |
| Streak milestones | 7, 30, 100, and 365 days |
| Streak delivery window | 09:00 in the user’s stored IANA timezone |
| Monthly recap timezone | Immutable `jars.timezone`, copied from the owner at jar creation |
| Monthly recap eligibility | Open or closed jar with activity that month; recipient must be active now and have been active during the month |
| Monthly recap | Immutable snapshot for the completed calendar month |
| Invite reminder | Owner only, 24 hours before expiry |
| Lock-screen notification text | Generic/private by default |
| Milestone, recap, invite notifications | Opt-in |
| Report and rescue notifications | On by default after OS permission, independently configurable |
| Account deletion | Immediate account lockout and local erasure; no grace period; five-minute target and 15-minute stuck alert |
| Owned open jars on deletion | Close them; never cascade-delete other members’ data |
| Shared history on deletion | Delete authored text/images/private data; preserve non-identifying numeric group history |
| Backup retention | 30 days, with erasure tombstones replayed before any restored DB serves traffic |
| Account-associated Temporal history | Actively delete after completion proof; 90-day namespace retention is only a fallback |

The deletion choices are product and legal decisions with material consequences.
They must be explicitly confirmed before the deletion migration is implemented.

## Dependency map and agent execution protocol

```text
W00 design/baseline
  -> W01 runtime
  -> W02 outbox/orchestration
       -> W03 push delivery
            -> W04 report accountability
            -> W05 urge rescue
            -> W06 streak milestones
            -> W07 monthly recap
            -> W08 invite lifecycle
       -> W09 session maintenance
       -> W10 account deletion
  -> W11 integrated UI/operations
  -> W12 migration rehearsal and release
  -> W13 production/TestFlight acceptance
```

During execution, the coordinating agent owns this document, the acceptance
ledger, integration, merges, deployment, and final proof. Subagents receive
bounded packets in separate `wtp` worktrees, push coherent commits frequently,
and report exact evidence. No two agents own the same files without an explicit
handoff. A packet is not marked complete from a subagent claim alone; the
coordinator verifies its commit, tests, and integration state.

After every merged packet, update the status and evidence ledgers at the end of
this document. That is the recovery point after context loss.

## W00 — Design, baseline, and decision lock

### Plan

Re-read the current code and deployment, incorporate any newer `origin/main`
changes, resolve the defaults above, inventory all existing user data, and write
the exact typed registries/state machines before implementation.

### Acceptance criteria

- [ ] W00.1 Current `origin/main`, open PRs, worktrees, production SHA, database
      migrations, Temporal namespaces/schedules, and TestFlight state are
      refreshed and recorded without relying on this dated baseline.
- [x] W00.2 Every workflow, activity, signal, query, event, notification category,
      workflow ID, schedule ID, timer, retry policy, and terminal state is listed.
- [x] W00.3 Postgres-authoritative versus Temporal-orchestrated responsibilities
      are explicit for every state transition.
- [ ] W00.4 The deletion table-by-table map and backup policy are approved before
      a destructive migration or deletion path is written.
- [ ] W00.5 All product/legal choices are dated and attributed; agents do not
      invent a legal retention requirement.
- [x] W00.6 The merged App Store control plan is updated where deletion packet
      statuses/evidence change; its other release packets remain separate.
- [x] W00.7 The final design follows the scalable-TypeScript guide and records
      discriminated states rather than boolean combinations.
- [x] W00.8 The status/evidence ledgers in this document are current.

## W01 — Product Temporal runtime and declarative registry

### Plan

Add a Node/glibc worker under `apps/dont-text-your-ex`, product-local workflow,
activity, and schedule registries, boot-time schedule reconciliation, a health
workflow, a third image, Pulumi workload, secrets, and metrics.

### Acceptance criteria

- [ ] W01.1 Temporal namespace `dont-text-your-ex` is declaratively registered by
      its own immutable setup Job.
- [ ] W01.2 Every product workflow and schedule uses task queue exactly `main`.
- [ ] W01.3 A Don’t Text Your Ex-scoped guard asserts the worker, its schedules,
      config, Pulumi, tests, and runbook resolve to `main`; it does not inspect or
      reject legitimate queues owned by other products.
- [ ] W01.4 The product-owned worker does not register with or import the Control
      Center feature workflow registry.
- [ ] W01.5 `www-dont-text-your-ex-temporal-worker` builds for linux/amd64, is
      digest-pinned, participates in product-aware path filters, and is required
      by the deployment fan-in.
- [ ] W01.6 The worker runs in Kubernetes namespace `dont-text-your-ex`, connects
      to the shared Temporal frontend, and mounts only required product secrets.
- [ ] W01.7 Missing database, Temporal, metrics, or configuration required by an
      enabled Apple/APNs capability fails boot with structured redacted errors;
      a capability not yet enabled in its staged rollout does not block W01.
- [ ] W01.8 Worker and Temporal SDK metrics are scraped by Prometheus.
- [ ] W01.9 Graceful shutdown stops polling and bounds in-flight activity time.
- [ ] W01.10 A health workflow proves namespace, queue, worker, activity, and
      history persistence without depending on an external integration.
- [ ] W01.11 Namespace retention is explicitly 90 days and tested.
- [ ] W01.12 Schedule reconciliation owns only a Don’t Text Your Ex prefix,
      upserts declared schedules, deletes removed managed Schedule definitions,
      and never removes unmanaged schedules or workflow execution histories.
- [ ] W01.13 Documentation distinguishes Schedule deletion, execution termination,
      execution-history deletion, domain retention, and account erasure.

## W02 — Transactional domain-event outbox and orchestration module

### Plan

Introduce an append-only outbox written inside existing domain transactions. A
small adapter maps event versions to start, signal-with-start, or update calls.
Immediate dispatch minimizes latency; a managed recovery workflow drains missed
events in bounded pages.

### Acceptance criteria

- [ ] W02.1 A migration adds branded event ID, event type, schema version,
      aggregate type/ID, occurrence time, dispatch state, attempt metadata, and
      terminal failure without storing private event payloads.
- [ ] W02.2 Jar creation/closure, invite rotation, report creation/resolution,
      slips, joins/leaves, crossed jar milestones, rescue transitions, deletion
      requests, and every requested notification emit required versioned events
      in the same transaction as domain truth.
- [ ] W02.3 A successful mutation remains successful while Temporal is down,
      leaves a recoverable event, and returns within a tested short dispatch
      timeout/circuit-breaker bound rather than hanging on Temporal.
- [ ] W02.4 Immediate post-commit dispatch and scheduled recovery use the same
      idempotent adapter.
- [ ] W02.5 Concurrent dispatchers claim rows with ordering and locking that
      prevents simultaneous ownership.
- [ ] W02.6 An event becomes dispatched only after Temporal accepts its operation.
- [ ] W02.7 A crash after Temporal acceptance but before acknowledgement cannot
      duplicate an internal workflow start or database effect. External APNs
      delivery remains at-least-once and uses best-effort collapse/deduplication.
- [ ] W02.8 Signal-with-start or an equivalent ordering-safe design handles a
      resolution, closure, departure, or deletion arriving before creation is
      dispatched.
- [x] W02.9 Poison events stop after a declared policy, remain inspectable, alert,
      and do not block later events.
- [x] W02.10 Pending count, oldest age, retries, permanent failures, and dispatch
      latency are measured without high-cardinality user labels.
- [ ] W02.11 Failure injection proves rollback, Temporal outage, duplicates,
      worker death, poison events, and crash-after-side-effect recovery.

## W03 — Native push and NotificationDeliveryWorkflow

### Exact behavior

`NotificationDeliveryWorkflow({ notificationId, schemaVersion })` reloads the
current notification, authorization, preferences, and active device registrations;
records one internal delivery intent per eligible device; retries transient APNs
failures; deactivates invalid tokens; records terminal outcomes; and never makes
push availability a precondition for core product behavior. APNs delivery is
at-least-once: collapse IDs and durable intent keys minimize duplicates, but the
system does not claim exactly-once delivery across a network/crash ambiguity.

Lock-screen text is generic; authenticated deep links reveal details only after
current authorization succeeds.

| Category | Recipient and timing | Default | Generic copy | Deduplication key |
|---|---|---|---|---|
| Report | Accused immediately, 24h, and 72h while pending | On | “You have an accountability update.” | report + stage + device |
| Slip | Current active jar members except the actor, after commit | Opt-in | “Your jar has new activity.” | slip + recipient + device |
| Join | Current active jar members except the joining member, after commit | Opt-in | “Someone joined your jar.” | membership + recipient + device |
| Jar milestone | Current active members after the milestone transaction | Opt-in | “Your jar reached a milestone.” | jar + threshold + recipient + device |
| Streak milestone | The streak owner at the local delivery window | Opt-in | “You reached a streak milestone.” | streak instance + threshold + device |
| Recap | Eligible current members after snapshot creation | Opt-in | “Your monthly recap is ready.” | jar + month + recipient + device |
| Invite | Jar owner 24h before expiry or immediately when already inside that window | Opt-in | “Your jar invite expires soon.” | invite version + owner + device |
| Rescue | The intervention owner at a check-in deadline | On | “Time to check in.” | intervention + deadline + device |

### Acceptance criteria

- [ ] W03.1 The iOS target has correct production push capability, entitlement,
      provisioning, native/Capacitor integration, and APNs environment.
- [ ] W03.2 APNs device tokens are encrypted at rest with a dedicated mounted
      key; each row records key version, user, platform, app build, timestamps,
      active state, and last failure. A tested rotation job re-encrypts old rows
      before retiring a key version.
- [ ] W03.3 Registration/upsert, APNs device-token rotation, user switching on a shared
      device, logout, deletion, and invalid-token deactivation are tested.
- [ ] W03.4 Permission denial never blocks authentication or a core feature.
- [ ] W03.5 Users can independently configure every notification category.
- [ ] W03.6 The workflow reloads preferences and active devices immediately before
      each delivery attempt.
- [ ] W03.7 Transient errors retry with bounded exponential backoff; permanent
      APNs responses do not retry and deactivate invalid registrations.
- [ ] W03.8 A unique notification/device intent prevents duplicate internal sends
      and supplies an APNs collapse ID; tests and UI tolerate an externally
      duplicated push.
- [ ] W03.9 Attempts and terminal outcomes persist without raw tokens or private
      notification bodies in logs or Temporal history.
- [ ] W03.10 Lock-screen copy never exposes private labels, evidence, report notes,
      rescue state, or an anonymous reporter.
- [ ] W03.11 Deep links authenticate and authorize before showing their target,
      otherwise showing an honest unavailable/expired state.
- [ ] W03.12 Foreground, background, and terminated-app delivery work on a real
      TestFlight iPhone in production.
- [ ] W03.13 Delayed, duplicated, rejected, and disabled push all preserve correct
      in-app state.

## W04 — ReportAccountabilityWorkflow

### Exact behavior

One workflow keyed by opaque report ID starts after report creation. It attempts
an immediate notification, waits to 24 hours and 72 hours for reminders, and at
seven days conditionally changes only `pending` to `expired`. Own/deny remain
atomic Postgres transactions and signal completion. Closure or accused departure
ends reminders. Expiry notifies the reporter without revealing anonymous identity.

### Acceptance criteria

- [ ] W04.1 Creation starts exactly one workflow and absence/non-pending/closed/
      departed state exits harmlessly.
- [ ] W04.2 Immediate, 24-hour, and 72-hour notifications occur only while pending.
- [ ] W04.3 Seven-day expiry wins only through a conditional `pending -> expired`
      transition.
- [ ] W04.4 Resolve and expiry races have one winner and never create duplicate
      slips, tally changes, streak resets, or activity.
- [ ] W04.5 Owning still creates exactly one slip/tally delta/streak reset/activity;
      denying never creates a slip or changes tally/streak.
- [ ] W04.6 Closure and accused departure stop all future reminders.
- [ ] W04.7 Anonymous identity is absent from DTOs, pushes, logs, workflow metadata,
      metrics, and histories.
- [ ] W04.8 Existing pending reports backfill from original time; reports already
      older than seven days expire without sending historical reminders.
- [ ] W04.9 Contracts and UI exhaustively represent `expired`.
- [ ] W04.10 Time-skipping tests cover every timer, early resolution, races,
      duplicate events, closure, departure, backfill, and worker restart.

## W05 — UrgeRescueWorkflow and “Don’t Send It” experience

### Exact behavior

The user starts one private intervention from a prominent “Don’t Send It” action.
The server persists it and starts one workflow keyed by intervention ID. A
ten-minute cooldown survives app suspension. At each non-final deadline, the
workflow changes `active -> check_in_due`, sends one reminder, and opens a
five-minute response window. The user can signal `safe`, `slipped`, or `extend`.
`extend` is accepted only during `active`/`check_in_due`, advances the deadline by
ten minutes from the prior deadline, returns to `active`, and is capped at two
extensions and 30 minutes from start. Without a response or extension, the
workflow marks `abandoned` after the five-minute response window. At the absolute
30-minute limit it marks `abandoned` immediately. `safe` records a private
success. `slipped` opens the existing slip confirmation and never charges
automatically. No message draft is collected.

### Acceptance criteria

- [ ] W05.1 Intervention states are a discriminated union of `active`,
      `check_in_due`, `safe`, `slipped`, and `abandoned` with authoritative
      server timestamps and deadline/extension count.
- [ ] W05.2 One active intervention per user is enforced transactionally.
- [ ] W05.3 Start, safe, slipped, and extend commands are authenticated,
      authorized, idempotent, and recoverable through the outbox.
- [ ] W05.4 Deadlines, five-minute response windows, extension eligibility, and
      the absolute 30-minute limit follow the exact transitions above; an extend
      after abandonment or a terminal signal is rejected harmlessly.
- [ ] W05.5 Non-final deadlines deliver one reminder only when enabled; response
      timeout or absolute limit marks abandonment once.
- [ ] W05.6 `safe` never creates a slip; `slipped` never creates one without the
      normal explicit slip confirmation.
- [ ] W05.7 Suspension, termination, reinstall, and a second authenticated device
      reconstruct current state from the server.
- [ ] W05.8 No draft, ex label, contact, message content, or friend notification is
      collected or emitted.
- [ ] W05.9 The experience has Storybook states and mobile pointer tests for
      loading, active countdown, extend, safe, slipped, abandoned, offline,
      duplicate submit, recoverable failure, and unavailable state.
- [ ] W05.10 Time-skipping tests cover every state, extension limit, race,
      duplicate signal, resume, and worker restart.

## W06 — StreakMilestoneSweepWorkflow

### Exact behavior

An hourly managed schedule scans active memberships in open jars whose user’s
local clock has reached their 09:00 delivery window and whose `streak_start_at`
is non-null. It calculates real streaks and creates at-most-once achievements for
7, 30, 100, and 365 days. The achievement key includes membership, the exact
streak-start instant, milestone, and reached local date, so a later post-reset
streak can earn the milestone again while a timezone change cannot duplicate the
same streak achievement. Notifications are private. Shared jar activity is
allowed only when the membership’s current `shareStreak` remains true at send
time.

### Acceptance criteria

- [ ] W06.1 Users have a validated IANA timezone with an explicit migration
      fallback and a documented device-refresh policy.
- [ ] W06.2 The hourly schedule uses task queue `main` and handles DST without
      skipped or duplicate local days.
- [ ] W06.3 A unique membership/milestone record prevents repeated achievement.
- [ ] W06.4 A streak reset before delivery suppresses stale notification.
- [ ] W06.5 Milestones remain private by default; shared activity requires current
      explicit opt-in and never reveals earlier private history.
- [ ] W06.6 Paging is deterministic and continues as new before unbounded history.
- [ ] W06.7 Tests cover timezone and DST edges, null streaks, reset races,
      timezone changes, repeat milestones after a genuine reset, opt-in/out,
      duplicates, departed members, closed jars, and large pages.

## W07 — MonthlyJarRecapWorkflow

### Exact behavior

A managed schedule produces one immutable recap for each eligible jar and
completed calendar month using immutable `jars.timezone`, copied from the
creator’s current IANA timezone at jar creation. Open or closed jars qualify when
they had at least one activity in that month. A recipient must be an active
member at send/read time and must have been active for some part of that month.
It calculates exact slip count, total amount, tally change, qualifying
shared-streak highlights, and crossed jar milestones from real persisted data.
The recap is stored and readable in-app; push is only an announcement.

### Acceptance criteria

- [ ] W07.1 Jar/month uniqueness makes generation idempotent.
- [ ] W07.2 The immutable jar timezone and exact open/closed/activity/
      historical-current membership eligibility above are encoded and tested.
- [ ] W07.3 Metric queries are documented and never invent comparisons for
      missing data.
- [ ] W07.4 The persisted recap is an immutable snapshot and is not silently
      recalculated later.
- [ ] W07.5 Only authorized recipients can fetch it.
- [ ] W07.6 Private streaks, private labels, report evidence/notes, and anonymous
      identity never appear.
- [ ] W07.7 Empty months, closure, departure, privacy, duplicates, month boundaries,
      and pagination have tests.
- [ ] W07.8 Recap UI has Storybook and mobile browser coverage for loading, empty,
      populated, unavailable, offline, and retry states.

## W08 — InviteLifecycleWorkflow

### Exact behavior

Jar creation and invite rotation mint a non-secret invite-version ID. One
workflow waits until 24 hours before expiry, rechecks that the jar is open and
the same version is current, and reminds only the owner. Rotation supersedes the
old lifecycle; closure ends it. Postgres continues enforcing expiry even if
Temporal is unavailable. If dispatch occurs with zero to 24 hours remaining, it
revalidates and reminds immediately once; an already expired invite is skipped.

### Acceptance criteria

- [ ] W08.1 Workflow arguments/history contain the version ID, never the invite
      code or URL.
- [ ] W08.2 Revalidation immediately before sending proves open/current/unexpired.
- [ ] W08.3 Rotation cannot produce an old-version reminder.
- [ ] W08.4 Closure terminates the lifecycle and only the owner is eligible.
- [ ] W08.5 Synchronous invite validation remains authoritative during outages.
- [ ] W08.6 Rotation races, near-expiry creation, exact expiry, closure, disabled
      notification, duplicate dispatch, and worker restart are tested.

## W09 — SessionMaintenanceWorkflow

### Exact behavior

A daily managed schedule deletes unpresented expired sessions in bounded batches.
Authentication continues rejecting and deleting an expired presented token
synchronously; maintenance is hygiene, never an authorization dependency.

### Acceptance criteria

- [ ] W09.1 No session token enters workflow history, metrics, or logs.
- [ ] W09.2 Purge is idempotent and safe with concurrent sign-in/session use.
- [ ] W09.3 Active sessions survive and all eligible expired sessions are removed.
- [x] W09.4 Large purges continue as new and expose safe counts/duration metrics.
- [ ] W09.5 The schedule uses task queue `main` and produces inspectable history.

## W10 — AccountDeletionWorkflow and compliance erasure

### Exact behavior

Profile exposes an easy-to-find Delete Account action requiring explicit
confirmation and fresh Sign in with Apple authorization. Accepting the request
atomically creates one opaque deletion request, captures a cleanup manifest and
restore tombstone, transfers encrypted Apple revocation material into the
deletion control record, makes the account unavailable, revokes every app
session, and emits one event. The state machine is:

```text
accepted
  -> erasing
  -> locally_erased
  -> apple_revocation_pending
  -> complete | manual_action_required
```

The account is locked synchronously. Local erasure targets five minutes and
alerts at 15 minutes; it has no terminal “give up” state and keeps retrying until
`locally_erased`. Apple revocation retries transient failures for up to 24 hours.
HTTP 200, including already-invalid tokens, completes it. Missing legacy
credentials or a terminal/nonrecoverable Apple result produces
`manual_action_required` after local erasure. The initial UI explains that
deletion has been accepted, that the user will be signed out, and the maximum
Apple-revocation window; old credentials cannot query account state afterward.

The stable workflow then:

1. Uses the pre-erasure cleanup manifest to suppress/terminate associated work.
2. Atomically erases live personal data without cascading into another member’s
   account or unrelated records.
3. Retains only numeric group history that has no product field or stable
   identifier capable of programmatically linking it to the deleted identity;
   authored text, images, labels, and identity are removed.
4. Revokes Sign in with Apple authorization through an injected adapter.
5. Destroys retained revocation material after the terminal Apple outcome.
6. Records an opaque completion receipt and keyed restore tombstone.
7. Lets a separate compliance sweeper delete associated execution histories,
   including the completed deletion workflow, because it cannot delete itself.
8. Allows later Apple sign-in to create a genuinely new account without using
   the tombstone to relink or restore erased data.

Account-deletion behavior by workflow is fixed as follows:

| Associated work | Deletion behavior |
|---|---|
| Pending report involving the user | Conditional `pending -> expired` with internal `account_deleted` reason; delete/redact authored note/evidence and end accountability workflow |
| Terminal report involving the user | Preserve terminal numeric outcome where needed; delete/redact identity, note, and evidence; no new notifications |
| Rescue intervention | Suppress notification, terminate workflow, and erase intervention row |
| Notification delivery | Mark pending intents suppressed, terminate open delivery, then erase device and private delivery data |
| Owned jar invite | Close the owned jar, supersede the invite, and end invite workflow |
| Member-only jar invite | No jar-wide change; current invite lifecycle remains owned by the jar owner |
| Streak/recap sweep | Current-state activity excludes deleting/deleted users; no per-user execution is “resolved” |
| Session maintenance | Sessions are already revoked; maintenance sees nothing user-specific |

The restore tombstone stores only `deletionRequestId`, a dedicated-key HMAC of
the deleted internal user ID, completion time, and expiry. The restoration tool
scans restored user IDs, computes the same HMAC, and reapplies erasure before any
traffic. The raw user ID and Apple subject are not retained. The HMAC key is
mounted only into deletion/restoration paths, has a recorded version and rotation
procedure, and is never used during sign-in. Tombstones expire 31 days after
completion, one day after the last 30-day backup that can contain deleted data.

Local erasure must proceed even when legacy accounts lack usable Apple revocation
material. Before accepting that specific request, the UI presents the manual
Apple-revocation step described by TN3194 and never claims programmatic
revocation succeeded.

### Acceptance criteria

- [ ] W10.1 Profile has an accessible Delete Account action explaining exactly
      live deletion, shared history, owned-jar closure, backups, irreversibility,
      Apple authorization, and re-registration.
- [ ] W10.2 Confirmation is deliberate and fresh authentication is verified;
      ordinary logout is not represented as deletion.
- [ ] W10.3 Acceptance atomically records the request/state, cleanup manifest,
      keyed restore tombstone, transferred encrypted revocation material, account
      lock, all-session revocation, and one event.
- [ ] W10.4 Old sessions fail immediately; a deleting/deleted user cannot mutate
      product data or retrieve private data.
- [ ] W10.5 Repeated/concurrent requests resolve to one workflow and one terminal
      erasure outcome.
- [ ] W10.6 The workflow input is only opaque `deletionRequestId` plus schema
      version; workflow IDs contain no user or Apple identifier.
- [ ] W10.7 Native Sign in with Apple returns the authorization code securely;
      the server validates/exchanges it and securely stores only the revocation
      material required by Apple.
- [ ] W10.8 Apple keys, client secrets, authorization codes, access/refresh tokens,
      and subjects never appear in logs, histories, metrics, screenshots, CI, or
      evidence artifacts.
- [ ] W10.9 Apple revocation treats HTTP 200/already-invalid as success, retries
      transient failures durably, classifies terminal errors, and supports the
      documented missing-legacy-token path without blocking local deletion. The
      five-minute erasure target, 15-minute alert, 24-hour Apple retry deadline,
      and `manual_action_required` outcome are tested.
- [ ] W10.10 A table-by-table map covers users, Apple credentials, exes, avatars,
      sessions, devices, preferences, memberships, jars, slips, reports, report
      evidence, activity, interventions, notifications, outbox, recaps, deletion
      requests, logs, Temporal histories, and backups.
- [ ] W10.11 Foreign keys are expanded/migrated so deleting one user cannot delete
      another user, their membership, or unrelated shared records.
- [ ] W10.12 Owned open jars close rather than cascade-delete; other members retain
      permitted non-identifying numeric history and access according to the
      approved closed-jar contract.
- [ ] W10.13 Profile/name/avatar/private labels/device identifiers/authored notes/
      evidence images and anonymous reporter linkage are removed from live data.
- [ ] W10.14 Under the product threat model, no retained product field or stable
      identifier in rows, DTOs, push, activity, recap, logs, metrics, or workflow
      metadata exposes or programmatically links the deleted identity. This does
      not claim to erase another human’s memory of prior interactions.
- [ ] W10.15 The pre-erasure manifest finds every account-associated execution,
      and each workflow follows the exact account-deletion behavior table above;
      no workflow is generically “resolved” in a way that changes domain meaning.
- [ ] W10.16 Associated completed/open Temporal histories are inventoried and
      deleted by a separate authorized compliance sweeper after durable completion
      proof; Schedule-definition reconciliation is not used for this.
- [ ] W10.17 Daily NFS backups have enforced 30-day retention and documented
      encryption/access controls.
- [ ] W10.18 A restore cannot serve resurrected deleted data: unapplied erasure
      tombstones are replayed before application traffic, and tombstones expire
      only after every containing backup has aged out. Tombstone HMAC fields,
      key/version ownership, access, rotation, 31-day retention, restore algorithm,
      and prohibition on sign-in/relink use match the exact design above.
- [ ] W10.19 Loki/frontend-log/crash/metrics retention is documented; user identity
      is not used as a Prometheus label; deletable live logs are handled per policy.
- [ ] W10.20 Completion leaves no usable session, APNs token, Apple identifier,
      profile field, private label, authored note, or evidence image in live DB.
- [ ] W10.21 A deleted Apple account can sign in later as a new user without old
      jars, tallies, reports, interventions, or preferences reappearing.
- [ ] W10.22 Real-Postgres tests cover owner/member/former/outsider, owned/shared
      jars, reports/evidence, concurrent/repeated delete, injected failures,
      rollback, Apple outcomes, old-token rejection, and re-registration.
- [ ] W10.23 Storybook and mobile tests cover pending, offline, failure, retry,
      accepted, missing-legacy-token, terminal success, local credential cleanup,
      focus, VoiceOver naming, and 44-point targets without false success.
- [ ] W10.24 Public privacy/account-deletion documentation accurately states the
      in-app path and actual retention behavior and is not a generic SPA fallback.
- [ ] W10.25 A dedicated production account proves real Apple revocation, live
      erasure, workflow/history cleanup, other-member preservation, and new-account
      registration on a physical TestFlight iPhone.
- [ ] W10.26 Production enablement has `disabled`, dedicated-test-account
      `allowlist`, and `enabled` stages. Live W10.25 proof occurs in allowlist mode;
      general availability is enabled only afterward.

## W11 — Cross-cutting privacy, UI, observability, and operations

### Acceptance criteria

- [ ] W11.1 Every new HTTP boundary validates unknown data with shared Zod
      contracts and exhaustive domain states.
- [ ] W11.2 Every workflow-backed read, command, signal, and deep link performs
      current authentication and authorization.
- [ ] W11.3 Structured logs redact secrets and all private content named above.
- [ ] W11.4 No user, report, jar, workflow, or device identifier is an unbounded
      Prometheus label.
- [ ] W11.5 Every new screen is Storybook-first with honest loading, empty,
      offline, validation, submitting, retry, success, and terminal states.
- [ ] W11.6 Forms preserve input after recoverable failure and block duplicate
      submission without false success.
- [ ] W11.7 Focus order, semantic names, 44-point targets, contrast, reduced
      motion, Dynamic Type, and VoiceOver flows are verified.
- [ ] W11.8 Workflow state refreshes correctly after background/resume and from a
      second device.
- [ ] W11.9 Grafana exposes pollers, workflow/activity failures, retries, task
      latency, outbox lag, push outcomes, schedule health, and stuck deletions.
- [ ] W11.10 Alerts cover no pollers, old/growing outbox, missing schedules, high
      permanent push failure, repeated workflow failure, and stuck deletion.
- [ ] W11.11 Runbooks cover Temporal/APNs outage, poison events, stuck deletion,
      failed reconciliation, worker rollback, replay incompatibility, execution
      deletion, and restore-time erasure replay.
- [ ] W11.12 Operators can correlate an event to execution and delivery outcome
      using safe opaque IDs.
- [ ] W11.13 Runbooks use `kubectl`/Temporal tooling against `home-server`, never
      SSH, the retired mini, or Pulumi stack `prod`.

## W12 — Automated verification, replay safety, migration, and rollback

### Acceptance criteria

- [ ] W12.1 Workflow tests use Temporal’s time-skipping environment.
- [ ] W12.2 Transaction, lock, FK, idempotency, and erasure tests use real Postgres.
- [ ] W12.3 APNs and Apple tests use injected adapters with precise transient,
      permanent, already-revoked, and invalid-token classifications; CI never
      contacts production services.
- [ ] W12.4 At least one CI lane runs worker + Temporal + Postgres and proves
      transaction -> outbox -> workflow -> activity completion.
- [ ] W12.5 Tests cover duplicate events/signals, invalid transitions,
      cancellation, termination, continue-as-new, worker restart, and rollback.
- [ ] W12.6 Sanitized replay fixtures exist for every workflow type and CI replays
      them against every worker build.
- [ ] W12.7 Incompatible control-flow changes use Temporal patch/version features
      or a new workflow type; retained exports are not renamed away.
- [ ] W12.8 A rolling worker deploy can process executions started by the prior
      production worker, and rollback names the last compatible image.
- [ ] W12.9 Database rollout is expand/backfill/contract; old API pods remain
      compatible while additive migrations and worker deployment roll.
- [ ] W12.10 Workflow emission stays disabled until namespace and compatible
      pollers are proven ready.
- [ ] W12.11 Existing reports, invites, and sessions have resumable, idempotent
      backfills with scanned/created/skipped/error counts. A fixed cutoff is
      recorded, compatible worker pollers are healthy before emission, and live
      writes on either side of the cutoff cannot be skipped or duplicated.
- [ ] W12.12 Rollback never deletes the Temporal namespace or Postgres data and
      does not strand unsupported outbox versions.
- [ ] W12.13 Push can be disabled independently without changing domain truth.
- [ ] W12.14 Account deletion remains `disabled` until the erasure map, Apple
      revocation, backup retention, and restore replay are ready; it then moves to
      dedicated-test-account `allowlist` for live proof before `enabled`.
- [ ] W12.15 Product API/frontend/worker/infra/Storybook/e2e paths select all
      required tests and three image builds.
- [ ] W12.16 `bun run typecheck`, relevant unit/integration tests, Storybook,
      Playwright, Biome, Knip, Docker guards, app/codegen checks, and Pulumi tests
      pass at the immutable merge SHA.
- [ ] W12.17 A production-shaped migration and rollback rehearsal passes before
      merging the enabling change.

## W13 — Merge, deploy, TestFlight, and live acceptance

### Acceptance criteria

- [ ] W13.1 When Calum explicitly starts the implementation goal, create one
      successor delivery Ticket referencing planning Ticket T-40. Do not create
      one Ticket per packet. Coherent implementation slices use dedicated `wtp`
      branches/worktrees, frequent pushed commits, green PRs, review evidence,
      and reference that one delivery Ticket.
- [ ] W13.2 PRs merge only when CI is green and target `main`; deployment uses only
      Pulumi stack `home-server`.
- [ ] W13.3 CI records immutable API, frontend, and Temporal-worker image digests.
- [ ] W13.4 Kubernetes proves API, frontend, worker, and CNPG healthy at deployed
      SHA/digests.
- [ ] W13.5 Temporal proves namespace `dont-text-your-ex`, 90-day retention, and
      active pollers on task queue exactly `main`.
- [ ] W13.6 Declared and live managed schedules match exactly; unmanaged schedules
      and histories remain untouched.
- [ ] W13.7 Health workflow completes, outbox backlog reaches zero, and Grafana
      shows healthy worker/schedule/activity metrics without new alerts.
- [ ] W13.8 A worker restart during a waiting workflow proves durable timers and
      signals survive.
- [ ] W13.9 Dedicated production fixtures prove report create/resolve/expiry,
      rescue safe/slipped/abandoned, streak milestone, recap, invite rotation,
      and session purge. Report expiry uses an operator-created backdated domain
      fixture with the real production workflow; rescue waits its real 30-minute
      maximum. No user-accessible production timer override exists. A separate
      short canary may prove generic timer/restart mechanics but not product timing.
- [ ] W13.10 A real TestFlight iPhone proves foreground/background/terminated APNs,
      authenticated deep links, rescue resume, report resolution, and preferences.
- [ ] W13.11 Dedicated multi-user production data proves no private fields leak
      through reports, streaks, recaps, notifications, histories, logs, or metrics.
- [ ] W13.12 Dedicated account deletion proves the complete W10 live flow,
      including real Apple revocation and preservation of the other member.
- [ ] W13.13 Post-deletion backup/restore rehearsal uses a network-isolated
      temporary database/namespace, applies tombstones before enabling even test
      traffic, proves erasure, and destroys only that synthetic environment. It
      never restores over live production.
- [ ] W13.14 The production ledger records SHA, Actions run, image digests,
      Kubernetes rollout, Temporal executions, database assertions, Grafana,
      TestFlight build, device evidence, and explicit proof boundaries.
- [ ] W13.15 If the iOS binary changes, a signed processed TestFlight build newer
      than Build 24 is installed and tested; processing alone is not acceptance.
- [ ] W13.16 Public web/API health and an off-network check pass after deployment.
- [ ] W13.17 A second no-op deployment proves schedule reconciliation,
      migrations, and workflow replay remain stable.
- [ ] W13.18 The factory merge webhook moves planning Ticket T-40 to `done` when
      this plan PR merges. The later delivery Ticket follows the same merged-PR
      rule. Production/TestFlight completion remains governed by the goal ledger;
      a post-merge defect creates a new Ticket rather than holding or reopening a
      Ticket contrary to the tracker contract.

## Explicit non-goals

- Moving short atomic jar/slip/tally/report mutations into Temporal.
- Real payments, payouts, Stripe, Apple Pay, or settlement collection.
- Committee voting on denied gameplay reports.
- Collecting message contents, contacts, or ex conversations.
- Shared rescue/accountability-friend notifications in this delivery.
- Rebuilding the historical generic product-platform abstraction.
- Treating this workflow program as completion of every moderation, store
  listing, legal, creative, or public-App-Store packet in the separate release
  control plan.

## Status ledger

| Packet | Status | Owner | Branch/PR | Blocking decision or evidence |
|---|---|---|---|---|
| W00 Design/baseline | IN PROGRESS | coordinator | `codex/dtye-temporal-delivery`, T-42 | Reconcile the two committed deletion proposals with explicit owner choice |
| W01 Temporal runtime | IMPLEMENTED; LIVE PROOF PENDING | coordinator | PR #708 / `dd7f8f612` | Merge/deploy evidence remains in W13 |
| W02 Outbox/orchestration | IMPLEMENTED; LIVE PROOF PENDING | coordinator | PR #708 / `codex/dtye-outbox-observability` | W12/W13 live failure drills remain |
| W03 Push delivery | IMPLEMENTED; LIVE PROOF PENDING | coordinator | PR #708 / integrated from `9d9080a47` | Deploy projected Apple/APNs credentials and prove foreground/background/terminated delivery |
| W04 Report accountability | IMPLEMENTED; LIVE PROOF PENDING | coordinator | PR #708 / integrated from `05386fbbc` | Deployed outbox/APNs/expiry proof remains in W13 |
| W05 Urge rescue | IMPLEMENTED; LIVE PROOF PENDING | coordinator | PR #708 / integrated from `7a58890e7` | Deployed timer/APNs/restart proof remains in W13 |
| W06 Streak milestones | IN PROGRESS | `/root/streak_milestones` | successor slice from PR #708 | W03 integrated; implementation active; owns migration 0015 |
| W07 Monthly recap | IN PROGRESS | `/root/monthly_recaps` | successor slice from PR #708 | W03 integrated; implementation active; owns migration 0016 |
| W08 Invite lifecycle | IN PROGRESS | `/root/invite_integration` | successor slice from PR #708 | Core persistence/workflow landed; central wiring and replay proof active |
| W09 Session maintenance | IMPLEMENTED; LIVE PROOF PENDING | coordinator | PR #708 / coordinator branch | W12/W13 schedule and production purge proof remain |
| W10 Account deletion | NOT STARTED | — | — | W00 deletion decisions, W02, Apple revocation |
| W11 UI/operations integration | NOT STARTED | — | — | W03–W10 |
| W12 Verification/migration | NOT STARTED | — | — | W01–W11 |
| W13 Production/TestFlight | NOT STARTED | coordinator | — | W12 green |

## Evidence ledger

Append one row for every accepted proof. “Observed” without timestamp, source,
commit/build, and proof boundary is not evidence.

| Date/time | Criterion(s) | Result | Commit/build | Evidence | Reviewer |
|---|---|---|---|---|---|
| 2026-08-15 | Baseline/history trace | PASS | `f2426fdc8` | Source/ref/PR review proved no DTYE Temporal or deletion implementation; PR #703 merged the plan only | deletion Git/history review |
| 2026-08-15 | Acceptance-contract review | PASS after corrections | plan branch | Independent review checked runtime, outbox, APNs guarantees, all workflow states, deletion/backup semantics, tests, and live proof; 24 findings were reconciled | workflow acceptance review |
| 2026-08-16 | Delivery goal and tracker | PASS | T-42 | Explicit `Do it.` request created the implementation goal and the one successor delivery Ticket | coordinator |
| 2026-08-16 | W00 repository/production refresh | PASS with implementation gaps | `3b4697e37` | Main CI/CodeQL green; migrations 0001–0009 live; API/frontend/CNPG healthy; Temporal has only `control-center` and `software-factory` product namespaces; no DTYE worker/namespace yet; Build 24 state is bounded by the merged P00 evidence | coordinator + live Git/Kubernetes/Postgres inspection |
| 2026-08-16 | W00 runtime/outbox design trace | PASS | coordinator branch | Two independent traces fixed the product runtime seam, 22-event registry, transaction hazards, public TDD seams, schema dependencies, and deletion-plan conflict; ADR-0014 and the deletion data map are the durable synthesis | `/root/runtime_design`, `/root/outbox_workflows`, coordinator |
| 2026-08-16 | W01 implementation checkpoint | PASS; live proof pending | `dd7f8f612` | Product worker tests 7/7, shared runtime tests 2/2, infra tests 5/5, task-queue contract guard, root typecheck, Biome, Knip, and Node 22 slim/glibc image build passed; namespace/poller/amd64 rollout proof remains W13 | `/root/runtime_design`, coordinator |
| 2026-08-16 | W02 transaction/outbox foundation | PASS; dispatch integration pending | `dd7f8f612` | Real PostgreSQL 16 suite passed 88/88 including rollback, concurrent mutation, lease race, exactly-once report resolution, and all implemented producer events; non-DB suite passed 52 with 36 database tests intentionally skipped | `/root/outbox_workflows`, coordinator |
| 2026-08-16 | W01/W02 independent foundation review | PASS after fixes | coordinator branch after `8b98f9cb8` | Seven findings were traced: durable IDs now enforce 128-bit entropy, event aggregate IDs are prefix/brand checked, health input/result are locked, worker/runtime tests run in CI, invite backfill IDs are random, and a boot-composition test proves schedules and worker creation receive the same exact `main` queue. Real PostgreSQL suite then passed 89/89 and worker tests 10/10. Dispatcher throw isolation and finite redacted failure codes are assigned to the active recovery slice. | `/root/foundation_review`, coordinator |
| 2026-08-16 | W02 dispatch/recovery and W09 session maintenance | PASS; ops/live proof pending | coordinator branch after `3e0eae35c` | Capability-filtered claims preserve unsupported facts unattempted; post-commit and scheduled recovery share the dispatcher; thrown adapters are isolated per event; error codes are finite at TypeScript and PostgreSQL boundaries; starts/signals use named opaque-ID contracts; session purge uses 500-row locked pages and continue-as-new. Real PostgreSQL API passed 96/96 and worker passed 16/16; linux/amd64 image and workflow bundle passed on the source slice. | `/root/outbox_workflows`, coordinator |
| 2026-08-16 | W02/W09 focused durability review | PASS after fixes; live proof pending | coordinator branch after `61e82c2da` | Dispatch is one event per activity with a 15-second Temporal RPC deadline, 25-second activity timeout, and 30-second row lease; post-commit nudges admit one unresolved batch; workflow inputs reject unknown schemas; session continue-as-new preserves one cutoff; cleanup now follows the exact daily contract. Worker passed 20/20 focused tests and both API/worker typechecks passed. | `/root/foundation_review`, coordinator |
| 2026-08-16 | W03 native push and notification delivery | PASS locally; secrets/live-device proof pending | integrated from `9d9080a47` | Exact opaque workflow input, encrypted token keyring/rotation, authenticated preference and registration APIs, finite APNs outcomes, per-device durable retries, late authorization checks, native opt-in/settings, production entitlement guard, and shared worker-pool lifecycle are implemented. Notifications passed 15/15, frontend 29/29, integrated worker 25/25, root typecheck and Knip passed; source slice additionally passed real PostgreSQL 82/82, Storybook 535/535, production frontend, SwiftPM, and unsigned simulator builds. | `/root/workflow_acceptance_review`, coordinator |
| 2026-08-16 | W02.9, W02.10, W09.4 operations instrumentation | PASS; live proof pending | `codex/dtye-outbox-observability` | Bounded platform metrics expose durable pending/oldest/quarantine gauges, retry/permanent outcomes, accepted dispatch latency, purge counts/duration, and activity freshness without identity labels. Checked-in Grafana panels and Prometheus rules cover old/growing/failed backlog and missing poller/recovery; deterministic collector/activity/infra tests pass and the runbook covers recovery. | `/root/outbox_workflows` |
| 2026-08-16 | Integrated W02/W03/W09 migration and runtime proof | PASS | coordinator branch after `e259a3c85` | Fresh PostgreSQL 16 applied migrations 0001 through 0012 in order. The combined API suite passed 104/104 and the worker suite passed 33/33 including real-Postgres session purge and durable operational snapshot tests. | coordinator |
| 2026-08-16 | W04 report accountability | PASS locally; live proof pending | integrated through `e08b255d0` | Migration 0013, exact 24-hour/72-hour/7-day timers, authoritative terminal signals, durable closure/departure events, account-deletion reason seam, immutable opaque history contracts, and replay safety are integrated. Combined worker tests passed 65/65 non-DB cases with 9 expected DB skips; source and integration real-Postgres proofs passed all W04 cases. | `/root/report_accountability`, coordinator |
| 2026-08-16 | W05 private urge rescue | PASS locally; live proof pending | integrated through `21f036dd0` | Migration 0014, authenticated server-authoritative state, exact cooldown/check-in/extensions, idempotent command races, private notification, account-deletion erase seam, mobile UI/Storybook states, replay, and an actual replacement-worker restart are integrated on task queue `main`. | `/root/foundation_review`, coordinator |
| 2026-08-16 | Combined W04/W05 integration | PASS after harness fix | `55c396a4b` | Fresh PostgreSQL 16 applied migrations 0001 through 0014. The combined API suite passed 117/117; combined worker suite passed 84/84 including all real-Postgres and actual Temporal tests; frontend passed 44/44 plus typecheck and production build. Integration exposed parallel shared-DB fixture deletion, now prevented by single-fork worker tests. The runtime-copy gate also gained coverage for SQL function calls and the rescue copy remains supportive. | coordinator |

## Resume instructions

1. Read this file, `AGENTS.md`, `CODEBASE_OVERVIEW.md`, and the scalable
   TypeScript guide before touching code.
2. Query planning Ticket T-40 and, after the explicit implementation goal starts,
   its single successor delivery Ticket; never use Beads.
3. Fetch `origin/main`, inspect open PRs/worktrees, and update the baseline.
4. Continue from the first non-complete packet in the status ledger.
5. Use `wtp add -b <branch> origin/main`; never edit the main checkout and never
   remove another session’s worktree or branch.
6. Use subagents for bounded parallel packets, with one owner per file cluster.
7. Update and push this ledger after every coherent accepted slice.
8. Do not mark the goal complete until W13 is fully evidenced.
