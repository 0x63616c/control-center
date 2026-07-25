# world-wide-webb

Smart-home wall-panel monorepo for the fixed `1366x1024` Control Center panel.

## Layout

`apps/` = things that run/deploy. `packages/` = things you import. `features/<id>/`
= self-contained Apps (manifest + `web.tsx`/`api.ts`/`jobs.ts`/`schema.ts`); the
folder existing is the App's registration (ADR-0001).

| Path | Purpose |
| --- | --- |
| `apps/web` | React board, Storybook, Capacitor iOS shell. Main route: `src/routes/index.tsx`. |
| `apps/api` | Bun + tRPC API, routers, DB schema, migrations, guest-WiFi listener. |
| `apps/worker` | Interval workers for reconciliation and ingest. |
| `apps/storybook` | Thin wrapper around the web Storybook. |
| `apps/map-provision` | Basemap tile provisioner image. |
| `features/*` | Self-contained feature Apps (tiles), glob-collected into `features/_generated/*.gen.ts` by `bun run apps:gen`. |
| `packages/api` | Browser-safe tRPC type bridge. |
| `packages/core` | Shared `device_state` store, DB/UniFi substrate (`@www/core`). |
| `packages/logger` | Shared backend logger. |
| `packages/platform` | Platform primitives for product identity, secrets, DBs, backups, and manifests. |
| `packages/worker-runtime` | Shared worker scheduling/runtime primitives. |
| `infra` | Pulumi + Kubernetes deploy program. |

## Runtime

`web -> tRPC api -> domain services -> Home Assistant / UniFi / Spotify / Postgres / media`

Workers reconcile desired state and ingest background data. UI tiles read merged state and show skeletons on missing data instead of fake values.

## Deploy

Push to `main` runs CI, builds changed multi-arch images (product-aware: only changed product images plus shared-package dependents), writes digest pins to `wwwinfra:imageDigests.*`, then runs `pulumi up` against the homelab Kubernetes cluster.

## Commands

```bash
bun install --frozen-lockfile
bun run dev
bun run test
bun run typecheck
bunx biome check .
bun run knip
```

Use `bun` and `bunx`, never `npm` or `npx`.

## Issue tracking

GitHub Issues (`gh issue`) is the tracker, since 2026-07-25. See `AGENTS.md`
for the label scheme and the verbatim-ask rule. `bd`/Beads was dropped
2026-07-11; the old tickets are archived under
[`docs/beads-archive/`](docs/beads-archive/) - `OPEN-IDEAS.md` for the
unfinished ideas, `beads-export.jsonl` for the full raw dump.

## Docs

- `CODEBASE_OVERVIEW.md`, repo map and runtime shape.
- `CONTEXT.md`, domain glossary / ubiquitous language.
- `CLAUDE.md`, AI agent instructions (symlink to `AGENTS.md`).
- `AGENTS.md`, repo-specific agent notes.
