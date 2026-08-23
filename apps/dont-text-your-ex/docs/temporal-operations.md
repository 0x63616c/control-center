# Don’t Text Your Ex Temporal operations

The product worker runs in Kubernetes namespace `dont-text-your-ex`, connects to
the shared Temporal frontend, and polls task queue exactly `main` in Temporal
namespace `dont-text-your-ex`. Closed histories have 90-day namespace retention.

The worker registers three UTC Schedules: `dtye_health` and
`dtye_outbox_recovery` each minute, plus the declared daily
`dtye_session_maintenance` run. `dtye_health` starts
`DtyeHealthCheckWorkflow` once per minute. The workflow calls the local health
activity five times and returns `{ status: "healthy", checks: 5 }`. It depends on
no external integration.

On boot, the worker upserts declared `dtye_` schedules and deletes only removed
Schedule definitions with that prefix. It never deletes unmanaged schedules,
Control Center `app_` schedules, or workflow execution histories. Schedule
deletion, execution termination, history deletion, product-data retention, and
account erasure are separate operations.

Useful production checks:

```sh
kubectl --context home-server -n dont-text-your-ex get pods
kubectl --context home-server -n dont-text-your-ex logs deploy/temporal-worker
kubectl --context home-server -n temporal port-forward svc/temporal-ui 8080:8080
```

The worker has a 20-second SDK shutdown grace period inside Kubernetes' bounded
pod termination. Its app metrics are scraped directly from the pod on port 9464;
Temporal SDK metrics use the shared in-cluster OTel collector and retain
namespace/task-queue labels.

The provisioned Grafana dashboard **Don't Text Your Ex - Temporal Operations**
shows durable outbox pending count, oldest age, quarantine count, retry volume,
event-to-dispatch latency, and session-purge outcomes. Metrics carry only the
worker service plus finite outcome/activity labels. They never carry a user,
jar, event, aggregate, workflow, device, or session-token identifier.

## Worker or schedule outage

Start in Grafana with the DTYE dashboard and the Temporal SDK worker dashboard.
Then establish whether the pod is absent, the `main` poller is silent, or only a
managed Schedule is unhealthy:

```sh
kubectl --context home-server -n dont-text-your-ex get deploy/temporal-worker pods
kubectl --context home-server -n dont-text-your-ex logs deploy/temporal-worker --since=30m
kubectl --context home-server -n dont-text-your-ex rollout status deploy/temporal-worker
kubectl --context home-server -n temporal run dtye-temporal-admin --rm -i --restart=Never \
  --image=temporalio/admin-tools:1.31.2 --command -- \
  temporal schedule list --namespace dont-text-your-ex --address temporal-frontend.temporal.svc.cluster.local:7233
```

Do not delete schedules or histories to clear an alert. Fix database/Temporal
connectivity or roll back to the last replay-compatible worker image, then let
the deployment become Ready. Worker boot reconciles all managed `dtye_`
schedules. Trigger recovery once if the oldest outbox age is still rising:

```sh
kubectl --context home-server -n temporal run dtye-temporal-admin --rm -i --restart=Never \
  --image=temporalio/admin-tools:1.31.2 --command -- \
  temporal schedule trigger --schedule-id dtye_outbox_recovery \
  --namespace dont-text-your-ex --address temporal-frontend.temporal.svc.cluster.local:7233
```

Recovery is complete only when the worker is Ready, Temporal shows a successful
`main` poller, oldest age and pending count return to zero (or a known incoming
steady state), and no permanent-failure count increased.

## Outbox recovery

The scheduled recovery workflow claims only event types registered by the
deployed dispatcher. Unsupported future types remain pending and unattempted.
A claim lease expiring after worker death makes the row claimable again. Never
manually mark a row `dispatched`: that state means Temporal accepted the named
start or signal operation.

Inspect aggregate counts and finite error codes without selecting private or
identity-bearing columns:

```sql
SELECT state, event_type, last_error_code, count(*)
FROM domain_event
GROUP BY state, event_type, last_error_code
ORDER BY state, event_type, last_error_code;

SELECT state, count(*) AS events,
       extract(epoch FROM now()) * 1000 - min(occurred_at) AS oldest_age_ms
FROM domain_event
WHERE state IN ('pending', 'claimed')
GROUP BY state;
```

If pending rows grow, confirm the deployed worker supports their event types
before triggering `dtye_outbox_recovery`. If claims remain live while the pod is
gone, wait for the lease to expire; do not clear ownership by hand during a live
dispatcher run.

## Poison events

An event is quarantined in `failed` after its finite retry policy is exhausted
or a permanent compatibility error is classified. `DtyeOutboxHasPermanentFailures`
remains active while any quarantined row exists. A failed row does not block
later events.

First group failures with the aggregate query above and correlate the opaque
event ID only in the restricted database/Temporal investigation. Fix and deploy
the handler or data-compatibility issue before replaying anything. For one
confirmed-safe event, re-arm it transactionally so the normal dispatcher—not an
operator—performs the Temporal operation:

```sql
BEGIN;
SELECT id, event_type, schema_version, last_error_code
FROM domain_event
WHERE id = :'event_id' AND state = 'failed'
FOR UPDATE;
UPDATE domain_event
SET state = 'pending', available_at = extract(epoch FROM now()) * 1000,
    attempt_count = 0, last_attempt_at = NULL, last_error_code = NULL,
    failed_at = NULL, claim_owner = NULL, claim_expires_at = NULL
WHERE id = :'event_id' AND state = 'failed';
COMMIT;
```

Trigger outbox recovery and verify the row reaches `dispatched`. Never bulk
re-arm unknown failure classes, and never put raw provider/exception text into
`last_error_code`; its database constraint permits only the finite registry.

## Account deletion erasure

`DtyeAccountDeletionErasureStuck` fires once a deletion's local erasure has
retried for fifteen minutes without Postgres proving `locally_erased`. The
workflow continues retrying; do not mark it complete or bypass erasure. Inspect
the worker and database health using only the opaque deletion request ID from
the restricted Temporal history. Never copy profile data, Apple credentials,
or deleted-user identifiers into alerts or incident notes.

Confirm the request remains in `accepted` or `erasing`, repair the underlying
database or worker failure, and verify the same workflow advances through
`locally_erased` to a terminal state. The privacy-safe counter records the
threshold crossing; successful completion is proved by Postgres state and the
workflow result, not by the alert resolving.

## Session maintenance recovery

Authentication rejects an expired presented token synchronously, so maintenance
lag is storage hygiene rather than an authorization bypass. The workflow deletes
locked 500-row pages, carries a single cutoff through pagination, and continues
as new before history grows without bound. Metrics expose only page outcome,
deleted count, and duration—not tokens or user IDs.

Inspect counts without selecting tokens, then trigger the managed Schedule:

```sql
SELECT count(*) AS expired_sessions
FROM sessions
WHERE expires_at <= extract(epoch FROM now()) * 1000;
```

```sh
kubectl --context home-server -n temporal run dtye-temporal-admin --rm -i --restart=Never \
  --image=temporalio/admin-tools:1.31.2 --command -- \
  temporal schedule trigger --schedule-id dtye_session_maintenance \
  --namespace dont-text-your-ex --address temporal-frontend.temporal.svc.cluster.local:7233
```

Verify successful workflow history, a fresh `session_maintenance` activity
timestamp, no new failure outcome, and expired count returning to zero. If it
fails repeatedly, inspect worker logs and Postgres health; do not delete active
sessions or bypass the bounded purge with an unreviewed bulk delete.
