# Codebase Overview

This repository is a Bun monorepo for a smart-home wall-panel dashboard. The app is built around a fixed iPad wall panel, a tRPC API, background reconciliation workers, and a Pulumi-managed Kubernetes deployment on the `home-server` Talos node (see `## Where Prod Runs`).

Product logic is organized as self-contained **Apps** under `features/<id>/` (ADR-0001/0002): each folder holds its own tile(s), tRPC router slice, jobs, and schema, and the folder existing *is* the App's registration. `bun run apps:gen` globs those manifests and emits checked-in aggregates under `features/_generated/*.gen.ts`; `bun run apps:check` re-runs codegen and fails on drift. Never hand-edit `_generated/`. See `AGENTS.md` for the full invariant list and the ADRs in `docs/adr/` for the "why."

## Runtime Shape

```text
iPad / browser
  -> web React board
  -> /trpc same-origin HTTP
  -> api Bun + tRPC server
  -> features/<id>/api.ts router slices (merged into featureAppRouter)
  -> Home Assistant / UniFi / Spotify / Postgres / media integrations

background loops and jobs
  -> worker
  -> features/_generated/workers.gen.ts App-owned cycles
  -> @control-center/api/worker migrations + durable queue infrastructure
  -> desired-state reconciliation, weather ingest, party mode, weight ingest,
     GitHub deploy polling

device-local maintenance
  -> native Capacitor shell calendar schedule
  -> must work without backend or Temporal connectivity

deploy
  -> GitHub Actions
  -> GHCR amd64 images (the home-server node is x86)
  -> Pulumi in infra/ (stack `home-server`)
  -> Talos Kubernetes on home-server (192.168.0.5)
```

## Where Prod Runs

Prod is a **single-node Talos Linux Kubernetes cluster** called `home-server`
(`192.168.0.5`, amd64, RTX 3060). It is the only production environment.

**There is no SSH into it.** Talos ships no shell and no sshd; port 22 is closed by
design. Administer it with `talosctl` (node level) and `kubectl` (cluster level):

```
export TALOSCONFIG=$PWD/infra/talos/clusterconfig/talosconfig
talosctl dashboard                  # node TUI; binary is talosctl, not talos
export KUBECONFIG=$PWD/infra/talos/clusterconfig/hs.kubeconfig
kubectl get pods -A
```

`infra/talos/clusterconfig/` is **gitignored and regenerated per session**
(`talhelper genconfig`) because it holds the cluster CA and admin client key. The
Talos machine config source of truth is `infra/talos/talconfig.yaml`.

Naming to be aware of: the Talos/kubectl context is `prod` / `home-server`, and the
Pulumi stack is `home-server`. A second Pulumi stack named `prod` still exists but
targets the **retired Mac mini** - never deploy it (its cloudflared would split-brain
the live tunnel). The mini was powered off on 2026-07-25 and is kept as a cold spare,
so anything in this repo still referencing `homelab` is stale by definition.

## Workspace Layout

Single-product repo (SDD track 0, Task 9 flattened `products/control-center/*`
to the root; captive-portal was folded into the guest listener inside `api/`
and its own product folder is gone):

Deployable apps live under `apps/` (Track B plan decision 6: `apps/` = things
that run/deploy, `packages/` = things you import); product features live under
`features/`:

- `features/<id>/` - one folder per self-contained App (`ac`, `booth`, `ctrl`, `deploys`,
  `dogcam`, `events`, `felogs`, `guest-wifi`, `network`, `notif`, `panel-update`, `sound`,
  `tesla`, `tv`, `wakes`, `weather`, `weight` today). Each has a `manifest.ts` (tile placement, id) plus
  whichever convention facets it needs: `web.tsx` (Tile face), `detail.ts` (Tile View declaration), `api.ts` (tRPC
  router slice), `jobs.ts` (queue job handlers), `worker.ts` (interval cycles), `schema.ts` (owned tables),
  `temporal.ts` (Temporal workflow types + schedules, ADR-0008) with its
  implementation siblings `workflows.ts` (sandboxed) and `activities.ts`.
- `features/_generated/*.gen.ts` - committed codegen output (`bun run apps:gen`):
  `tiles.gen.ts`, `web.gen.ts`, `router.gen.ts`, `guest-router.gen.ts`, `jobs.gen.ts`, `workers.gen.ts`, `http.gen.ts`,
  `schema.gen.ts`, `workflows.gen.ts`, `activities.gen.ts`, `schedules.gen.ts`.
  Never hand-edit.
- `app-kit` - the `defineApp`/manifest types and server-side router-merging helpers
  every feature's `manifest.ts`/`api.ts` import.
- `apps/web` - React dashboard, Storybook, and Capacitor iOS shell (`apps/web/ios`).
- `apps/api` - Bun tRPC backend, DB schema/migrations, the non-feature base routers
  (health, settings, device-settings, system), durable queue infrastructure, and
  the guest-WiFi HTTP listener.
- `apps/worker` - Continuous interval workers for home-state reconciliation and ingest.
- `apps/temporal-worker` - Temporal worker (Node, not bun) serving `HealthCheckWorkflow` on the `main` task queue.
- `apps/dont-text-your-ex/apps/temporal-worker` - isolated product-owned Node
  worker for the `dont-text-your-ex` Temporal namespace, also polling task queue
  `main`; its first workflow is the product health check.
- `apps/storybook` - Thin wrapper delegating to the web Storybook.
- `apps/map-provision` - Basemap tile provisioner image.
- Software-factory source, tests, image builds, and immutable releases live in
  `0x63616c/software-factory` (ADR-0011/0012). This repo owns the production deployment
  integration: `infra/software-factory-release.json` pins one verified seven-image release,
  CI validates its provenance and registry digests, and Pulumi deploys those exact digests.
- `packages/api` - Browser-safe type bridge that re-exports the API router type only.
- `packages/core` - Owns the `device_state` table: schema, the `DeviceStateStore` interface, pg + in-memory adapters, and the desired/reported merge logic.
- `packages/logger` - Shared pino logger with centralized redaction and runtime-safe config.
- `packages/platform` - Pure platform foundation package for product identity, target, exposure, secret, database, backup, and Control Center representation primitives.
- `infra` - Pulumi program that declares the production k8s stack.
- `infra/observability` - Vendored observability data, not code: Grafana dashboard JSON and Prometheus recording rules, read at preview time by `infra/src/observability/`.
- `infra/unifi` and `infra/cloudflare` - Separate Pulumi projects for those providers.

Dependency boundaries between `packages/*`, `features/*`, and `apps/*` are enforced by a
Biome `noRestrictedImports` rule, not a separate dependency-graph tool.

## Frontend

The main route, `apps/web/src/routes/index.tsx`, renders `Board` from `apps/web/src/components/Board.tsx`.

The dashboard is not a normal responsive layout. It is a fixed wall-panel world:

- Target panel is `1366x1024`; board content constants are in `apps/web/src/lib/grid-constants.ts`.
- `BOARD_W = 1366`, `BOARD_H = 1000`.
- The board is a large `64x64` square-cell world.
- Panning uses native scroll, plus windowing so only visible cells mount.
- The wall panel runs one activity clock (`apps/web/src/lib/panel-session/`): any
  touch rearms it, and on timeout a single SESSION END dims the backlight, closes
  overlays, glides the camera home, and relocks the shared PIN unlock. Native
  (iPad) only; a ringing alarm counts as bounded activity (holds the session open
  and wakes a dimmed panel, still locked).
- Camera physics (pointer pan, all 5 snap modes, glide-home) live behind the
  `boardCamera` interface in `apps/web/src/lib/board-camera/`.
- Module-level web stores share one primitive: `createStore`/`useStore` at
  `apps/web/src/lib/store.ts` (settings, alarms, timers, tile-detail, modals, …).

Tile Placement, Panel access policy, and Tile View registration are declared
per-App, not centralized. Each `manifest.ts` declares Tile identity, rendering,
world placement, and client-only access (`sensitive` = shared session unlock;
`private` = fresh unlock per opening); each `detail.ts` declares only the owning
App's Tile Views. `bun run apps:gen` emits the
static `features/_generated/web.gen.ts` runtime consumed by the Board and Tile
Detail Host. Its `accessFor(tileId)` seam normalizes the two policies before a
Tile View mounts; `tiles.gen.ts` remains the data-only review projection. Codegen
validates that every Tile has exactly one Tile View before emitting either file.
There is no runtime placement override table; move or resize a Tile in its
manifest and rerun codegen.

Settings is a full-page (`1366x1024`) body-portal overlay, not a modal: `components/settings-page/` holds the shell (`SettingsPage.tsx`, sidebar + page routing), shared framing (`blocks.tsx`), the page registry (`pages.ts`), and its presentational pages under `pages/`. Live shared state comes from the module-level settings store (`lib/settings.ts`), while device-only controls use typed Capacitor bridges: the Time page's Panel maintenance card reads/writes the native nightly WebKit-refresh schedule and can invoke the same bounded reset on demand. Sensitive surfaces (Settings gear, Activity photos, and Apps whose manifest sets `sensitive`) share ONE PIN unlock per panel session (`components/pin/`, `PinGateModal` + `PinPadView`, on `panelSession.unlock()`): a successful PIN entry unlocks everything sensitive until the session ends (idle timeout relocks). A manifest's `private` policy remains distinct and prompts on every opening. The PIN is a synced settings field (`pinCode`, default `"000000"`), enforced frontend-only - the API never validates it beyond schema shape (ADR-0004: accepted until Slice S lands server-side `session.unlock(pin)`; the relock is only as strong as the client).

Data access is through tRPC React Query in `apps/web/src/lib/trpc.ts`. Queries retry with bounded exponential backoff; mutations do not retry. Unavailable data should render skeleton/error states, not invented values.

## API

The API entrypoint is `apps/api/src/server.ts`. It creates the root logger, runs migrations, then serves with `Bun.serve()`.

Routes include:

- `/up` - simple liveness.
- `/health/climate` - verifies live Home Assistant climate reachability.
- `/media/tv-artwork` - proxies Home Assistant artwork bytes so tokenized HA URLs stay private.
- `/media/wake-photo` (POST) + `/media/wake-photos/*` - ingests and serves the panel's wake-from-dim front-camera burst frames (stored under `MEDIA_STORAGE_DIR/wake-photos`).
- `/trpc/*` - tRPC request handling.
- Any HTTP routes owned by a feature's `http.ts` facet (e.g. the guest-WiFi captive
  portal listener in `features/guest-wifi/`) are collected into
  `features/_generated/http.gen.ts` and mounted alongside the routes above.

The tRPC root router is `apps/api/src/trpc/routers/index.ts`: a small non-feature
`baseRouter` (health, settings, device-settings, system) merged with the generated
`featureAppRouter` from `features/_generated/router.gen.ts`, which aggregates every
feature's `api.ts` router slice (today: `ac`, `booth`, `ctrl`, `deploys`, `dogcam`,
`events`, `felogs`, `guest-wifi`, `network`, `notif`, `sound`, `tesla`, `tv`, `wakes`,
`weather`, `weight`). Adding a feature's tRPC surface means writing its `api.ts` and
re-running `bun run apps:gen`, not editing this file.

`apps/api/src/trpc/init.ts` adds middleware that remaps `HaError` into tRPC `SERVICE_UNAVAILABLE`, so clients can recover through normal query error handling.

`packages/api/src/trpc.ts` is intentionally tiny. It re-exports only the `AppRouter` type from `@control-center/api/trpc`, allowing the web app to have typed tRPC without bundling backend runtime code.

## Domain Services

Feature-owned business logic lives inside each feature folder rather than a
shared `services/` directory. Interval-cycle implementations and cadence live
beside their owning App and are registered through `worker.ts` facets.

The Sonos sound-system query (now under `features/sound/`) classifies each group's
source from the coordinator's `GetMediaInfo` URI (`sourceKind`: line-in/tv/spotify/
airplay/other/idle) and carries now-playing metadata. The web Groups modal (patch-bay
UX, opened from the Sound System tile) moves speakers between live sources via
`sonosGroupJoin`/`sonosGroupLeave`, grabbing TV audio to the Beam first when needed.

A key pattern is DB-authoritative desired state:

```text
frontend writes desired state
  -> worker reconciles desired state to Home Assistant / Sonos
  -> reported state is observed separately
  -> frontend reads merged/effective state
```

This keeps dashboard taps immediately self-consistent and avoids fighting upstream systems unless the device policy says to enforce. See `packages/core` below for the shared store this depends on.

## Database

The Drizzle schema is composed from `apps/api/src/db/schema.ts` plus every feature's
own `schema.ts` (aggregated into `features/_generated/schema.gen.ts` by codegen). A
feature owns its tables end to end in its own folder rather than a shared schema file
growing without bound.

Major tables include:

- `job` - generic durable job queue.
- `events` - upcoming events (`features/events/`).
- `device_state` - desired and reported device state (`packages/core`).
- `device_commands` - command audit and in-flight tracking.
- `integration_sync_status` - integration/worker heartbeat state.
- `weather_reading` and `weather_daily_reading` - append-only weather history (`features/weather/`).
- `lamp_mode` - singleton persistent party-mode state.
- `weight_measurement` - append-only Renpho scale weigh-ins (kg canonical, lb display-only), ingested from an HA BLE sensor by the `weight-ingest` worker cycle; sanity-band/manual exclusions live in `excluded_reason`, surfaced by the Weight tile and its Trend/Readings detail pages via the `weight` tRPC router (`features/weight/`).

There is no longer a `board_tile_placement` table: tile position lives solely in each
feature's manifest (ADR-0001).

Both the API and workers run migrations at boot so whichever starts first can safely prepare the schema.

## Workers

`worker` owns process lifecycle, metrics, migrations, durable queue workers, and
graceful shutdown. Apps own interval cadence in `features/<id>/worker.ts`; codegen
composes those facets into `features/_generated/workers.gen.ts`. Duplicate names
fail `apps:gen` because worker names are global stats keys.

Registered workers currently include:

- `light-enforcer` every 1s.
- `climate-enforcer` every 1s.
- `sonos-volume-enforcer` every 1s.
- `device-sync` every 1s, currently fan-only.
- `party-mode` every 2s.
- `weather-ingest` every 5m.
- `withings-weight-ingest` every 10s (Withings API → `weight_measurement`).
- `github-actions-poll` every 10s (self-gated to one idle poll per minute).
- `asc-version-poll` every 1m (latest TestFlight build of the iOS shell, powering the board's update-available banner).
- Any feature-owned queue job types are aggregated into
  `features/_generated/jobs.gen.ts`; a feature adds a job by writing `jobs.ts` and
  re-running `bun run apps:gen`, not editing worker code directly. Scheduled work is
  declared in the `temporal.ts` facet and runs on Temporal (ADR-0008), not as
  CronJobs.

The shared runtime in `packages/worker-runtime` prevents overlapping cycles per worker, isolates failures, logs failure and recovery transitions, warns on slow cycles, and exposes stats.

## Temporal

Temporal runs on the cluster in its own `temporal` k8s namespace, declared by
hand in `infra/src/temporal.ts` - plain Deployments/Services/Jobs, no Helm chart
and no operator owning the cluster:

- `temporal-server` - 2 replicas of the combined frontend+history+matching+worker
  process, backed by its own CNPG Postgres (`temporal-postgres`) holding both the
  `temporal` and `temporal_visibility` databases. Two replicas survive a pod
  crash; on a single-node cluster nothing survives the node.
- `temporal-schema-setup` / `temporal-namespace-setup` - Jobs that install the
  schemas and register the `control-center` Temporal namespace. Schema work is a
  Job precisely so two server replicas cannot race the same migration, which is
  what the `auto-setup` image would do.
- `temporal-ui` - ClusterIP only; reach it with
  `kubectl -n temporal port-forward svc/temporal-ui 8080:8080`.
- `temporal-worker` - our worker (`apps/temporal-worker`), namespace
  `control-center`, task queue `main`. It registers every feature-declared
  workflow/activity from `features/_generated/` and RECONCILES the schedule set
  on each boot (ADR-0008): declared schedules are upserted, managed
  (`app_`-prefixed) schedules no longer declared are deleted.

`HealthCheckWorkflow` (owned by `features/temporal-health`) is the liveness
proof: a cron Schedule (`* * * * *`) firing 5 `HealthCheckActivity`
calls spread evenly across the minute. Each iteration sleeps against an absolute
deadline (`i * 60s/N` from workflow start) rather than a fixed gap, so activity
latency is absorbed by its own slot instead of accumulating.

`apps/temporal-worker` is Control Center's runtime that runs on Node rather than bun:
`@temporalio/core-bridge` publishes prebuilt glibc binaries only (no musl, so the
image is `node:22-slim`, never alpine), and the workflow sandbox is built on
node's `vm`.

Don’t Text Your Ex has a second Node Temporal runtime for product isolation. It
uses the shared schedule-reconciliation module but owns its workflow, activity,
and `dtye_` schedule registry. Its Schedule reconciler cannot delete Control
Center's `app_` schedules or workflow histories.

## Logging And Config

`packages/logger` provides `createLogger({ service })` and `getLogger()`. Backend processes create one root logger at startup. Shared domain services can call `getLogger()`, so the same code logs under `service: "api"` or `service: "worker"` depending on the running process.

Logger behavior is keyed off runtime env like `APP_ENV`, `LOG_LEVEL`, and `LOG_PRETTY`, not `NODE_ENV`, because Bun can inline `NODE_ENV` in single-file bundles.

Frontend logs (the web app's own log store, `apps/web/src/lib/log/`) are shipped to Postgres: a cursor-tracked shipper pushes every entry to the `logs.ingest` tRPC mutation, which writes the `frontend_log` table (30-day retention, purged daily). Every entry carries a stable `deviceId` (`<model-slug>-<idfv8>`), the mutable display `deviceName`, the git `sha`, and the App Store `build` number. To read panel logs from a desk, query Postgres instead of exporting from the device:

Successful polling is intentionally not logged. Failures, query error/recovery transitions, UI activity, and five-minute native process snapshots are retained; the native iOS recorder persists lifecycle state, physical/peak footprint, and memory-warning count atomically so the next launch can report an abruptly terminated process.

```
kubectl --context home-server -n control-center exec control-center-postgres-1 -c postgres -- \
  psql -U postgres -d control_center -c "select ts, level, source, msg from frontend_log \
  where level in ('warn','error') and ts > now() - interval '1 day' order by ts desc limit 100"
```

Design: `docs/superpowers/specs/2026-07-18-frontend-log-shipping-design.md`.

Env/config goes through the central registry at `packages/platform` (`@www/platform/env`): a single key manifest with a lazy, order-proof config Proxy, fail-fast `assertEnv` at boot (via each app's pinned `boot-env` import), and a Biome rule banning raw `process.env` in features. Production secrets are mounted as files under `/run/secrets/<NAME>` and hydrated at boot. Real credentials and private home-location values live outside git.

## Deployment

Production deploy is Pulumi + Kubernetes, not the historical bosun/Swarm path.

Important infra files:

- `infra/src/services.ts` - app workloads.
- `infra/src/crons.ts` - Kubernetes CronJobs.
- `infra/src/eso.ts` - External Secrets Operator resources.
- `infra/src/cnpg.ts` - CloudNativePG Postgres.
- `infra/src/certmanager.ts` - certificate automation.
- `infra/src/cluster.ts` - cluster-level setup.
- `infra/src/observability/` - the observability stack (#33): Prometheus,
  node-exporter, kube-state-metrics, Loki, Alloy and Grafana in the
  `observability` namespace. Hand-written resources, no Helm and no
  prometheus-operator/CRDs (ADR #207); the vendored dashboards and recording
  rules it mounts live in `infra/observability/`. See `docs/observability.md`.

GitHub Actions builds **amd64-only** images in `.github/workflows/ci.yml`: each Dockerfile builds once on a native `ubuntu-24.04` runner (no QEMU emulation) and pushes the final tags directly (`:<sha>`, plus `:main` on main). The arm64 leg and the `merge-*` manifest-index jobs were dropped when the arm64 Mac mini was retired (2026-07-25) - the home-server node is x86 and is the only deploy target. `scripts/test-build-matrix.sh` guards that (it fails if an arm64 leg or QEMU emulation reappears). CI then joins the tailnet with an ephemeral `tag:ci` identity, writes kubeconfig, sets Pulumi image digest config, and runs `pulumi up --stack home-server`.

The image digest config key must be namespaced as `wwwinfra:imageDigests.<svc>`. Without `wwwinfra:`, the Pulumi program does not read the values correctly.

## Scheduled Work

App-level scheduled work (every retention purge, plus health-check) runs as
Temporal Schedules declared from each feature's `temporal.ts` facet (ADR-0008,
tracked concern) - per-run history in the Temporal UI, retries, SKIP overlap, and
boot-time reconciliation from `features/_generated/schedules.gen.ts`.

Only infra-level jobs remain Kubernetes CronJobs in `infra/src/crons.ts`:

- `map-extract` - monthly basemap refresh (separate `map-provision` image).
- `pg-backup` - daily Postgres dump to the NAS.
- Home Assistant config + Postgres backups (declared in `homeassistant.ts`).

Do not add a third-party scheduler for new cron-style tasks.

## Data Safety

`scripts/pg-snapshot-restore.sh` is the reusable Postgres snapshot and scratch-restore proof tool. It supports dry-run planning, exact all-schema row-count SQL, custom-format dumps, plain SQL gzip dumps, scratch-only restores, and non-zero row-count mismatch failure. It rejects `production` / `control-center` as scratch targets so restore validation cannot overwrite the live database accidentally.

## Platform History

The repo previously moved toward a multi-product platform shape (Control Center
+ captive-portal as separate products under `products/<name>`). That shape is
gone: captive-portal's guest-WiFi flow was folded into a feature
(`features/guest-wifi/`, ADR-0006), and SDD track 0 Task 9 flattened `*` to the
repo root, so this is a single-product repo again. `docs/platform/*.html` are
historical design notes from that era, not the current layout.

Later, Track C (see `docs/adr/0001-features-are-self-contained-apps.md` and
`docs/adr/0002-app-registration-via-committed-codegen.md`) dissolved the central
`TILE_REGISTRY` / hand-written `appRouter` object literal / worker `Worker[]` array
into the `features/<id>/` + committed-codegen shape described throughout this
document. If you find a doc, comment, or test elsewhere in the repo still describing
tiles as living solely in `apps/web/src/lib/tile-registry.ts`, or business logic as
living solely in `apps/api/src/services`, treat this file and `AGENTS.md` as
authoritative over it.

CI path filters are scoped per app directory (`apps/web/**`, `apps/api/**`,
`apps/worker/**`, `apps/map-provision/**`), all rebuilding on `packages/**`,
`features/**`, or `bun.lock` changes too. Software-factory is not a workspace app and is
not built here; an `infra/**` change to its verified release lock triggers deployment.
The Tiltfile lives at the repo
root; root `bun run dev` runs `tilt up` directly. Local dev commands
(`dev:web`, `dev:api`, `dev:worker`, `dev:storybook`, `dev:db`, `ios:*`) live
on the root `package.json`.

`packages/platform` still holds product-identity, target, exposure, secret,
database, backup, and Control Center representation primitives consumed by
`infra/`; `controlCenterProductManifest()` is the live source of truth Pulumi
reads, not a filesystem-path abstraction.

`packages/core` owns the `device_state` table end to end: the drizzle schema,
the `DeviceStateStore` interface (read/list/listExpiredWindows/readEffective/
seed/upsertDesired/updateDesired/clearDesired/writeReported), the pure
desired+reported merge module, and two adapters behind that interface - a pg
adapter over the real table, and an in-memory adapter for tests. `api`'s five
device_state writers (light, climate, sonos-volume, device-sync enforcers, plus
the shared desired-state-store) and its readers all consume the store; services
take the store as a constructor/function param with the pg-backed singleton as
the default, so tests inject the in-memory adapter instead of stubbing drizzle.
`apps/api/src/db/schema.ts` re-exports the device_state types and table from
`@www/core` so existing `../db/schema` imports keep working.

## Development Rules To Preserve

- Use `bun` and `bunx`, never `npm` or `npx`.
- Run tests with `bun run test`, never bare `bun test`.
- Do not add fake, fallback, or placeholder data. Unavailable data should shimmer or error and recover.
- Backend code uses structured logging through `@www/logger`, not `console.*`.
- Tiles should use shared UI primitives from `apps/web/src/components/ui`.
- Component work should be Storybook-first where practical.
- IDs should default to Stripe-style `prefix_<id>`, minted via `genId()` from
  `packages/platform` (never hand-roll `prefix_${crypto.randomUUID()}`); a lefthook guard
  blocks hand-rolled ids outside `packages/platform/src/index.ts`.
- Deployment and operations changes should update docs in the same change.

## Injection tracking

`features/injections/` owns the medication course tracker, staged plans, actual
injections, vial accounting, synchronized timeline, check-ins and guided progress
photos. It reads canonical included measurements through `weight.timeline`.
See `features/injections/README.md` for calculation, scenario and media boundaries.

## Where To Start For A Feature

Adding a whole new tile/feature follows ADR-0001/0002: create `features/<id>/`
with a `manifest.ts` and whichever facets it needs, then run `bun run apps:gen`.
Extending an *existing* feature follows this vertical slice inside its folder:

```text
UI tile/component
  -> features/<id>/web.tsx
  -> tRPC hook from apps/web/src/lib/trpc.ts

API router slice
  -> features/<id>/api.ts
  -> validates input/output, merged into featureAppRouter by codegen

Persistent state
  -> features/<id>/schema.ts, if needed

Background work
  -> features/<id>/worker.ts (interval cycles via codegen),
     features/<id>/jobs.ts (queue jobs via codegen), or
     features/<id>/temporal.ts (scheduled workflows, ADR-0008)

Deploy shape
  -> infra/src/services.ts or infra/src/crons.ts, if needed
```
