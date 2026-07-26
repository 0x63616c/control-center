# Frontend Log Shipping — Design

Date: 2026-07-18
Status: approved

## Problem

The panel's frontend logs live only on the device (IndexedDB + native JSONL
mirror). Reading them means standing at the panel (LogsModal) or exporting via
the iOS share sheet. We want to read them from a desk — for Claude, that means
SQL — without standing at the panel.

## Decision summary

- **Sink: Postgres** (existing control-center CNPG cluster), not Grafana/Loki.
  SQL is the best read interface for agents and humans at a desk; the repo has
  no Loki/Grafana stack and standing one up for one panel's logs is not
  justified. Grafana can read the same table later via its Postgres datasource
  if ever wanted — the choice is not one-way.
- **Transport: tracked cursor, frontend-push.** The frontend remembers the last
  shipped entry id and pushes everything after it. Offline windows backfill on
  reconnect — no gaps, and the gaps are exactly the incidents worth reading.
- **Retention: 30 days**, enforced by a daily purge on the backend.
- **Read path v1: SQL only** (psql / kubectl exec). No UI, no alerting, no
  Grafana in this iteration.

> **Note added 2026-07-26 (#33).** "The repo has no Loki/Grafana stack" was true
> when written and is not any more: the constraint behind it — an 8 GiB Mac mini
> running lean — went away when that box was retired on 2026-07-25, and a
> Prometheus/Loki/Grafana stack now runs on home-server (#33, #216 —
> `docs/observability.md`). The decision itself is unchanged: **frontend logs
> still ship to Postgres**, and Loki collects container logs only. The
> "Grafana can read the same table later via its Postgres datasource" escape
> hatch is now actually available, but is not wired up.

## Device identity

Multiple devices ship logs (wall panel, iPhone, browser sessions). Two fields on
every entry:

- `deviceName` — the human label, already captured per entry. Changeable in the
  settings modal at any time; treated as display-only, never as identity.
- `deviceId` — stable, readable, unique: `<model-slug>-<idfv8>`, e.g.
  `ipad13-1-3f9a2c1b`.
  - Native: model slug from `@capacitor/device` `getInfo().model`, suffix =
    first 8 hex of `getId()` (Apple identifierForVendor). OS-derived, so it
    survives webview storage eviction and app updates; changes only on
    uninstall+reinstall, which is acceptable — a reinstall genuinely is a new
    log source.
  - Web (browser/Storybook): `web-<8 hex>` minted once and persisted in
    localStorage.
  - Resolved once at boot (async plugin call), cached in memory; entries logged
    before resolution get the id stamped at flush time, same pattern as
    `deviceName`.

Backend primary key is `(device_id, entry_id)` — entry ids (`bootMs-seq`) are
only unique per device.

## Frontend shipper (`web/src/lib/log/ship.ts`)

- Cursor = last-shipped entry id, persisted in localStorage
  (`cc-logs:ship-cursor:<deviceId>`). Lost cursor (evicted storage) means
  re-shipping from wherever the backend already has rows — idempotent, see
  ingest.
- Runs after each flush tick (the existing 3s loop in `logger.ts`): query the
  store ascending from the cursor (new `after` mode on `store.query` — today it
  only pages backwards via `before`), send batches of 500, cap ~10 batches per
  tick so a long backlog catches up in minutes without hogging the panel.
- Transport: tRPC mutation (the web app's existing api client). Success →
  advance + persist cursor. Failure/offline → stop, retry next tick. No local
  retry queue needed — IndexedDB IS the queue.
- All four levels ship. Retention is the size control, not level filtering.
- Shipping failures must never affect logging itself (same best-effort contract
  as the native mirror). The shipper logs its own health at `debug` sparingly
  (e.g. first failure after a healthy run, catch-up completion), never per tick.

## Build number tagging

Entries gain a `build` field alongside `sha`: the App Store / TestFlight build
number (e.g. `"80"`), from `@capacitor/app` `getInfo().build`, resolved at boot
and stamped at capture time. Web sessions: `"web"`. Answers "which binary was
the panel running", which `sha` alone cannot (same sha can be rebuilt; the
binary lags the web deploy).

## Backend

### Schema (drizzle, `frontend_log`)

| column       | type        | notes                                  |
| ------------ | ----------- | -------------------------------------- |
| device_id    | text        | pk part 1                              |
| entry_id     | text        | pk part 2 (`bootMs-seq`, lexicographic)|
| ts           | timestamptz | capture time                           |
| level        | text        | debug/info/warn/error                  |
| source       | text        |                                        |
| msg          | text        |                                        |
| data         | jsonb       | nullable payload                       |
| sha          | text        | git sha of the web bundle              |
| build        | text        | app build number ("80", "web")         |
| device_name  | text        | display label at capture time          |
| received_at  | timestamptz | default now()                          |

Indexes: `(ts)`, `(level, ts)`. PK gives the per-device id lookup.

### Ingest (tRPC `logs.ingest`)

- Input: zod-validated batch (max 500) of entries + deviceId.
- `insert … on conflict do nothing` — resends and cursor resets are idempotent
  by construction; no dedup bookkeeping anywhere.
- Payload `data` size-capped at capture time already (`truncated` flag exists);
  ingest additionally rejects any single entry whose serialized form exceeds a
  sane bound (guard against a pathological payload, mirrors structured-logging
  invariant).
- Returns count accepted; the frontend advances its cursor on any 2xx.

### Retention

Daily purge deletes `frontend_log` rows older than 30 days. Follows the purge
pattern in the api (`purge.ts` / weather purge service shape — whichever the
weather-retention work lands, this follows it).

### Backups

`pg_dump` includes the table (NFS PV labels already bumped to 10Gi; NFS capacity
is nominal, NAS free space is the real ceiling). If dumps ever grow
uncomfortable, excluding `frontend_log` is a one-flag change — debug logs don't
merit backup (each device holds its own copy).

## Reading (v1)

```
kubectl --context cc-homelab -n control-center exec control-center-1 -c postgres -- \
  psql -U postgres -d control_center -c "select ts, level, source, msg from frontend_log
  where level in ('warn','error') and ts > now() - interval '1 day' order by ts desc limit 100"
```

## Testing

- Shipper: fake transport — cursor advance on success, halt on failure,
  backfill after simulated offline, idempotent resend after cursor loss,
  per-tick batch cap.
- Store: ascending `after` query mode.
- API: ingest validation, conflict-idempotence, oversized-entry rejection;
  purge cutoff at 30 days.
- Device id: native (fake Device plugin), web fallback, persistence.

## Docs

- `CODEBASE_OVERVIEW.md` / relevant docs updated: frontend logs now mirrored to
  Postgres (`frontend_log`, 30-day retention), how to query them.
- `CLAUDE.md` gains a pointer: panel frontend logs are queryable in the
  control-center Postgres (`frontend_log` table) — read there instead of asking
  for an export.

## Out of scope

- Alerting, Grafana/Loki, any UI viewer over the backend table.
- Backfilling history captured before this ships.
- Backend-log unification (backend keeps its stdout structured logging).
