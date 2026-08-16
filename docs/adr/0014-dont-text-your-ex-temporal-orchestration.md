# Don’t Text Your Ex owns an isolated Temporal orchestration plane

Don’t Text Your Ex (DTYE) owns a Temporal namespace named
`dont-text-your-ex`, a Node/glibc worker deployed in the Kubernetes namespace
`dont-text-your-ex`, and one task queue named exactly `main`. Its workflow,
activity, event, signal, query, and schedule names are compatibility contracts.
They do not share Control Center's generated workflow registry or database.

Postgres remains the source of domain truth. Temporal owns durable waiting,
retry, dispatch, and coordination. A committed domain transaction writes both
the domain change and an opaque-ID-only outbox event. Temporal may be down when
that transaction commits; a bounded post-commit nudge and a scheduled recovery
workflow eventually dispatch the same operation idempotently.

This ADR fixes the implementation vocabulary before workflow code ships. It
does not mark a reserved workflow as implemented. Delivery status and evidence
remain in `docs/plans/dont-text-your-ex-temporal-workflows.md`.

## Runtime boundary

- Temporal namespace: `dont-text-your-ex`.
- Namespace retention: 90 days (`2160h`). Account-associated histories are
  actively deleted after erasure proof; retention is only a fallback.
- Task queue: `main`.
- Managed Schedule prefix: `dtye_`.
- Worker image: `www-dont-text-your-ex-temporal-worker`, linux/amd64,
  `node:22-slim` runtime. The Temporal native bridge must never run on musl.
- Workflow inputs contain one schema version and opaque product IDs only.
  Names, Apple identifiers or credentials, device tokens, invite codes, notes,
  evidence, private labels, notification copy, and profile fields are forbidden
  from workflow IDs, inputs, results, memo, search attributes, logs, and
  metrics.
- Activities reload current authorized state from Postgres immediately before
  each effect. A stale history is never authorization.
- Workflows use Temporal time, deterministic IDs derived from their input, and
  version markers for incompatible history changes. Activities own I/O.
- Schedule reconciliation can create, update, and delete only `dtye_` Schedule
  definitions. It has no workflow-history deletion capability.

The only shared runtime module is the narrow Schedule reconciliation protocol.
DTYE continues to own its registry, worker lifecycle, workflows, activities,
configuration, and image. This is reuse of one deep adapter, not a return of the
old generic multi-product framework.

## Workflow compatibility registry

| Workflow type | Trigger and workflow ID | Signals | Query | Terminal result |
|---|---|---|---|---|
| `DtyeHealthCheckWorkflow` | `dtye_health`; Schedule-generated ID | none | none | `{ status: "healthy", checks: 5 }` |
| `OutboxDispatchRecoveryWorkflow` | `dtye_outbox_recovery`; Schedule-generated ID | none | none | page counts and terminal dispatch classifications |
| `NotificationDeliveryWorkflow` | `notification/<notificationId>` | `accountDeleted` | `deliveryState` | `delivered`, `suppressed`, or `permanent_failure` per intent |
| `ReportAccountabilityWorkflow` | `report/<reportId>` | `owned`, `denied`, `jarClosed`, `memberDeparted`, `accountDeleted` | `accountabilityState` | `owned`, `denied`, `expired`, `jar_closed`, `member_departed`, or `account_deleted` |
| `UrgeRescueWorkflow` | `rescue/<interventionId>` | `safe`, `slipped`, `extend`, `accountDeleted` | `rescueState` | `safe`, `slipped`, `abandoned`, or `account_deleted` |
| `StreakMilestoneSweepWorkflow` | `dtye_streak_sweep`; Schedule-generated ID | none | none | bounded due-user page processed |
| `MonthlyJarRecapWorkflow` | `recap/<calendarMonth>/<pageId>` | none | none | bounded eligible-jar page processed |
| `InviteLifecycleWorkflow` | `invite/<inviteVersionId>` | `superseded`, `jarClosed`, `accountDeleted` | `inviteState` | `reminded`, `superseded`, `closed`, `expired`, or `account_deleted` |
| `SessionMaintenanceWorkflow` | `dtye_session_maintenance`; Schedule-generated ID | none | none | bounded expired-session pages deleted |
| `AccountDeletionWorkflow` | `deletion/<deletionRequestId>` | none | `deletionState` | `complete` or `manual_action_required` after local erasure |
| `DeletionHistorySweepWorkflow` | `dtye_deletion_history_sweep`; Schedule-generated ID | none | none | eligible cleanup manifests processed |

Signals are idempotent commands carrying the target aggregate's opaque ID,
expected aggregate version, and schema version. They never carry a changed
domain field. A signal causes the workflow to reload and conditionally apply
the authoritative Postgres transition.

Start arguments use the workflow's named opaque identifier (`notificationId`,
`reportId`, `interventionId`, `inviteVersionId`, or `deletionRequestId`) plus
`schemaVersion`; there is no generic `aggregateId` start contract. A
signal-with-start uses that same minimal start argument and passes the expected
aggregate version only in its separate signal argument.

## Schedule registry

All schedules use overlap policy `SKIP`, a one-minute catch-up window, task
queue `main`, and a single object argument.

| Schedule ID | Cron / timezone | Workflow | Execution timeout |
|---|---|---|---|
| `dtye_health` | `* * * * *`, UTC | `DtyeHealthCheckWorkflow` | 2 minutes |
| `dtye_outbox_recovery` | `* * * * *`, UTC | `OutboxDispatchRecoveryWorkflow` | 5 minutes |
| `dtye_streak_sweep` | `*/15 * * * *`, UTC | `StreakMilestoneSweepWorkflow` | 10 minutes |
| `dtye_monthly_recap` | `5 * * * *`, UTC | `MonthlyJarRecapWorkflow` | 30 minutes |
| `dtye_session_maintenance` | `17 3 * * *`, UTC | `SessionMaintenanceWorkflow` | 10 minutes |
| `dtye_deletion_history_sweep` | `47 * * * *`, UTC | `DeletionHistorySweepWorkflow` | 30 minutes |

The UTC sweeps select due records using each user's stored IANA timezone or the
jar's immutable timezone. They do not create one Schedule per user or jar.
Monthly recap processes a completed local calendar month once; its uniqueness
key is `(jar_id, calendar_month)`.

## Domain event registry

Every event is schema version 1 and contains only `eventId`, `eventType`,
`aggregateType`, `aggregateId`, `aggregateVersion`, and `occurredAt`. It has no
arbitrary JSON payload. A consumer reloads the aggregate and treats missing or
ineligible state as a successful no-op.

| Event type | Aggregate | Temporal operation |
|---|---|---|
| `jar.created` | jar | recorded fact; invite event performs orchestration |
| `jar.closed` | jar | signal current invite and pending reports after reloading |
| `invite.issued` | invite version | start `InviteLifecycleWorkflow` |
| `invite.superseded` | invite version | signal the prior invite workflow |
| `membership.joined` | membership tenure | request eligible join notifications |
| `membership.left` | membership tenure | end affected pending reports after reloading |
| `slip.logged` | slip | request eligible slip notifications |
| `jar.milestone_crossed` | jar milestone | request eligible milestone notifications |
| `report.created` | report | start `ReportAccountabilityWorkflow` |
| `report.owned` | report | signal owned; emitted with the resulting slip events |
| `report.denied` | report | signal denied |
| `report.expired` | report | terminal fact and eligible reporter notification |
| `rescue.started` | intervention | start `UrgeRescueWorkflow` |
| `rescue.extended` | intervention | signal an accepted extension |
| `rescue.safe` | intervention | signal safe |
| `rescue.slipped` | intervention | signal slipped; does not itself create a slip |
| `rescue.check_in_due` | intervention | request the private check-in notification |
| `rescue.abandoned` | intervention | terminal fact |
| `streak.milestone_reached` | streak achievement | request eligible streak notification |
| `recap.created` | recap | request eligible recap notifications |
| `notification.requested` | notification | start `NotificationDeliveryWorkflow` |
| `account.deletion_requested` | deletion request | start `AccountDeletionWorkflow` |

The outbox uniqueness key is
`(aggregate_type, aggregate_id, aggregate_version, event_type)`. Claims use a
lease plus `FOR UPDATE SKIP LOCKED`. A dispatcher outcome is one of
`accepted`, `retryable`, or `permanent`; poison events become inspectable
`failed` rows and cannot block later events. Post-commit dispatch has a short
timeout/circuit breaker and never determines the HTTP mutation result.

Every durable identifier generated after this decision carries 128 bits of
random entropy. Event aggregate identifiers are prefix-validated at compile and
runtime boundaries: `jar`, `inv`, `mtn`, `slip`, `jms`, `rpt`, `rsi`, `sta`,
`rcp`, `ntf`, and `del` respectively for the aggregate types above. Human invite
codes, Apple subjects, user-authored text, and raw provider errors cannot satisfy
that contract. Legacy jar/report IDs remain valid only after a database-backed
authorization lookup proves they name an existing aggregate.

## Activity and retry classes

Activities expose domain operations, not SQL primitives. Their public seams are
`HealthStore`, `Outbox`, `WorkflowDispatcher`, `NotificationStore`,
`NotificationGateway`, `ReportAccountabilityStore`, `RescueStore`,
`StreakSweepStore`, `RecapStore`, `InviteLifecycleStore`,
`SessionMaintenanceStore`, `AccountDeletionStore`, `AppleRevocationGateway`,
and `WorkflowHistoryEraser`.

| Class | Start-to-close | Retry policy |
|---|---:|---|
| Pure database read/conditional mutation | 30 seconds | initial 1s, coefficient 2, maximum 30s, 10 attempts; constraint/auth/ineligible failures are non-retryable |
| One-event outbox dispatch | 25 seconds, 30-second row lease, 15-second Temporal RPC deadline | initial 2s, coefficient 2, maximum 1m, 10 attempts; at most 20 events before continue-as-new |
| Bounded database page | 2 minutes with heartbeat | initial 2s, coefficient 2, maximum 1m, 10 attempts |
| APNs delivery | 20 seconds | at-least-once; retry transient results up to 8 attempts, permanent/invalid-registration terminal; collapse ID is best-effort dedupe |
| Apple token exchange/revocation | 30 seconds per call | workflow-owned retry loop bounded to 24h; HTTP 200/already-invalid succeeds, transient retries, terminal/missing legacy material becomes `manual_action_required` only after local erasure |
| Temporal history deletion | 2 minutes with heartbeat | initial 5s, coefficient 2, maximum 5m, 10 attempts; never deletes the currently running sweep |

Local erasure is deliberately not capped by an attempt count. It targets five
minutes, emits a stuck alert at 15 minutes, and retries until Postgres proves
`locally_erased`.

## Product state machines

### Report accountability

```text
pending
  -> owned | denied
  -> expired (seven days)
  -> jar_closed | member_departed | account_deleted
```

The workflow requests notification immediately, after 24 hours, and after 72
hours only while the report remains pending and the recipient remains an
authorized active member. At seven days an activity conditionally writes
`pending -> expired`. Existing pending reports are backfilled from their
original creation time; already-old reports expire without stale reminders.

### Urge rescue

```text
active(deadline = start + 10m, extensions = 0)
  -> active(deadline + 10m, extensions + 1)  [at most twice, before deadline]
  -> check_in_due                            [at deadline]
  -> safe | slipped                          [within 5m response window]
  -> abandoned                               [no response]
```

An extension is rejected after the current deadline, after two extensions, or
past the absolute `start + 30m` bound. The response window does not extend that
bound. The intervention is private; this delivery sends no friend notification
and stores no message draft or content.

### Streak achievement

Eligibility requires an active membership, an open jar, a non-null streak
start, current sharing/notification authorization, and an unreached milestone
at 7, 30, 100, or 365 local days. Achievement uniqueness is
`(membership_id, streak_started_at, milestone_days, reached_local_date)`.
Timezone changes affect future local-day evaluation but do not rewrite an
achievement.

### Invite lifecycle

An invite version is valid for seven days. Its owner reminder is due 24 hours
before expiry. If issued inside that window, the reminder is immediately due;
an already-expired invite is skipped. Rotation supersedes the prior version.
Jar closure ends the current lifecycle.

### Account deletion

```text
accepted
  -> erasing
  -> locally_erased
  -> apple_revocation_pending
  -> complete | manual_action_required
```

Acceptance locks the account and revokes every session in the same transaction
that creates the opaque request, cleanup manifest, restore tombstone, protected
revocation material, and one event. Local erasure is not rolled back by an
Apple outage. The exact shared-jar row semantics remain a W00 owner decision;
the two conflicting repository proposals must be reconciled before its schema
migration is written.

## Notification category registry

| Category | Recipient/timing | Default after OS permission | Privacy and dedupe |
|---|---|---|---|
| `report` | accused immediately/24h/72h while pending; reporter on expiry | on | generic copy; `report/<id>/<stage>/<recipient>` |
| `rescue` | initiating user at check-in deadline | on | private generic copy; `rescue/<id>/<stage>` |
| `slip` | other eligible active jar members immediately | off | generic copy; `slip/<id>/<recipient>` |
| `join` | eligible current members except joiner | off | generic copy; `tenure/<id>/<recipient>` |
| `jar_milestone` | eligible active members on first threshold crossing | off | generic copy; `jar-milestone/<id>/<recipient>` |
| `streak_milestone` | user at 09:00 local time; shared activity only if opted in | off | private generic copy; achievement ID |
| `recap` | eligible recipient after immutable snapshot creation | off | generic copy; `recap/<id>/<recipient>` |
| `invite` | jar owner 24h before expiry or immediately inside that window | off | no invite code in push; invite-version ID |
| `account_deletion` | no push after acceptance; status is visible before local sign-out | off and immutable | no device delivery; deletion request ID |

APNs is at-least-once. A successful APNs response followed by a worker crash can
produce a duplicate. Internal rows and workflow starts are idempotent; APNs
collapse IDs reduce, but cannot eliminate, duplicate user-visible delivery.

## Consequences

- API routes and stores never import Temporal workflow names. They append typed
  domain events through `DomainTransactionRunner`.
- A `WorkflowDispatcher` adapter alone maps domain events to workflow
  start/signal operations and the fixed `main` task queue.
- Device tokens and Apple revocation material are encrypted outside Temporal
  history with dedicated versioned keys. Plaintext exists only inside the
  relevant integration adapter call and is never logged.
- Fast periodic scans are bounded, indexed, paged, and use continue-as-new where
  history growth warrants it.
- Deployment can enable capabilities independently. Missing APNs or Apple
  configuration fails boot only when that capability is enabled.

## Supersedes and clarifies

This ADR narrows ADR-0008's “one namespace, one queue” statement to Control
Center's App-owned schedules. DTYE is the independent Product established by
ADR-0013. Both products happen to use a queue named `main`, but in separate
Temporal namespaces and separate workers.
