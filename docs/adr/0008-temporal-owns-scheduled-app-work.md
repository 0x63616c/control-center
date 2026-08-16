# Temporal owns Control Center scheduled App work, declared from App facets

This ADR's one-namespace and generated-facet decisions apply to Control Center
Apps under `features/*`. The independently deployed Don’t Text Your Ex product
uses the same cluster and the exact `main` task-queue spelling in its own
`dont-text-your-ex` Temporal namespace, with a product-owned worker and registry.
It does not join the Control Center generated barrels.

App-level scheduled work runs as Temporal workflows on the self-hosted Temporal cluster
(`infra/src/temporal.ts`, namespace `control-center`, task queue `main`), and is declared
declaratively from each App via a `features/<id>/workflows.ts` facet — the same file-presence +
brand + committed-codegen mechanism every other facet uses (ADR-0001, ADR-0002). The Temporal UI
is read-only in practice: schedules exist because a deploy shipped them, never because someone
clicked.

This replaces the generated-k8s-CronJob path for the six purge crons (`deploys-purge`,
`felogs-purge`, `guest-wifi-purge`, `hooks-purge`, `wake-photo-purge`, `weather-purge`) and folds
the previously hardcoded `health-check` schedule into the same system as a `temporal-health`
feature. Once the sweep completes, the generated-cron machinery — the `defineCron` facet,
`crons.gen.ts`, `cron-handlers.gen.ts`, `generatedCronSpecs()`, and the `bun cron.js <name>`
entrypoint with its `boot-env-cron` hydration — is deleted.

## Why move off k8s CronJobs

The CronJob path accumulated real operational cost for app work (three stacked
layers of it): every cron run pulls a digest-pinned api image, so stale-pin bugs ship silently;
env hydration happens in a bespoke `boot-env-cron` entrypoint that once pointed purges at
localhost; per-run visibility is a Job pod's logs and nothing else; retry policy is "the pod
restarts". Temporal gives each run a persisted, inspectable history, real retry policies,
`SKIP` overlap semantics, heartbeats for long batched deletes, and the worker deploys like any
other service — no per-cron image plumbing.

## The facet

`workflows.ts` declares three things: workflow implementations (in sibling files that only the
SDK bundler touches), activities, and schedules (`{ scheduleId, workflowType, cron, args?,
overlap?, timeout? }`). Two constraints shape it:

**The workflow sandbox takes a path, not an import graph.** `apps/temporal-worker` hands the SDK
a bundler entry file; workflow code runs in a deterministic `vm` sandbox and cannot import feature
`api.ts`, the db, or anything effectful. Codegen therefore emits a `workflows.gen.ts` import
barrel that *is* the bundler entry, plus an activities barrel (activities run in the worker main
thread and may use `@www/core` and the db) and a `schedules.gen.ts` data listing.

**Codegen imports facets under bun; the worker runs Node.** `scripts/apps-gen` dynamically
imports every facet data-only, so the facet file must not top-level-import `@temporalio/workflow`
(a glibc-Node native dependency sits behind it). Workflow *type names* appear in the facet as
string literals, not `fn.name` — the existing `apps/temporal-worker/src/config.ts` trick, with a
test asserting literal and export agree.

## Schedules reconcile on boot, deletes included

On every boot the worker upserts each declared schedule and deletes any schedule it manages
(recognizable ID prefix) that is no longer declared. Declarative means removal works the same way
as addition: deleting the facet entry and deploying removes the schedule. Upsert-only was
rejected because orphaned schedules keep firing workflows against code that no longer expects
them, and a manual sweep step is exactly the UI-touching this ADR exists to eliminate.

## What stays where it is

- **Infra-level CronJobs remain k8s CronJobs**: the Postgres and Home Assistant backups exec
  other images (`cloudnative-pg/postgresql`, alpine) and are not app code. `map-extract` stays
  with them for now — it runs the separate `map-provision` image, and porting it or building
  Job-spawning glue is out of scope.
- **The `apps/worker` interval loops** (1s enforcers, pollers) are unchanged. Sub-minute control
  loops are the wrong shape for per-run workflow histories; whether the slower pollers migrate is
  deliberately deferred, along with the retention question fast cadences would raise (namespace
  retention is 10y, #157).
- **The Postgres job queue** (`packages/core/src/jobs`) is unchanged; migrating `notify` /
  `youtube_ingest` is deferred.
- **One task queue (`main`), one namespace.** Per-feature queues wait until a slow activity
  actually starves others; migrated crons are daily, so history volume is negligible.

## Rejected

**Status quo (generated k8s CronJobs).** Works, but the #27 class of digest/env/entrypoint bugs
is structural, and a live Temporal cluster serving only a liveness check is the worst of both
worlds — full operational cost, none of the benefit.

**Runtime self-registration of schedules from feature code.** Forbidden by ADR-0002; the
committed-codegen path keeps the full schedule set reviewable in a diff.

**A second short-retention namespace now.** Only worth it if fast-cadence pollers migrate;
decided when that decision is made.

## Consequences

Workflow and activity code lives in-feature (ADR-0001 self-containment) but executes only in
`apps/temporal-worker` — the repo's one Node runtime — so shared code used by migrated handlers
must not depend on bun-only APIs. The Biome boundary rules gain an allowance for the
temporal-worker → `features/*` generated barrels. `apps-check.ts` drift-checking extends to the
new artifacts (and backfills the three aggregates it silently missed: `jobs.gen.ts`,
`cron-handlers.gen.ts`, `http.gen.ts`). The temporal-worker Deployment gains the same
Postgres-credential file mount the api/worker pods have, since purge activities need the db.
