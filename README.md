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

Push to `main` runs CI, builds changed multi-arch images (product-aware: only changed product images plus shared-package dependents), writes digest pins to `wwwinfra:imageDigests.*`, then runs `pulumi up` against the `home-server` stack.

Prod is a single-node **Talos Linux** Kubernetes cluster, `home-server` (`192.168.0.5`, amd64, RTX 3060) — the only production environment. Talos has no shell and no sshd, so there is **no SSH into it**; use `talosctl` for the node and `kubectl` for the cluster:

```sh
export TALOSCONFIG=$PWD/infra/talos/clusterconfig/talosconfig
talosctl dashboard
export KUBECONFIG=$PWD/infra/talos/clusterconfig/hs.kubeconfig
kubectl get pods -A
```

`infra/talos/clusterconfig/` is gitignored and regenerated per session with `talhelper genconfig`, since it contains the cluster CA and admin client key. Machine config lives in `infra/talos/talconfig.yaml`.

A Pulumi stack named `prod` also exists but targets a retired Mac mini (powered off 2026-07-25, kept as a cold spare) — never deploy it; its cloudflared would split-brain the live tunnel.

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

## Ticket tracking

software-factory Tickets are the tracker, since 2026-07-31. See `AGENTS.md`
for the verbatim-ask rule and creation workflow. `bd`/Beads was dropped
2026-07-11; the old tickets are archived under
[`docs/beads-archive/`](docs/beads-archive/) - `OPEN-IDEAS.md` for the
unfinished ideas, `beads-export.jsonl` for the full raw dump.

## Docs

- `CODEBASE_OVERVIEW.md`, repo map and runtime shape.
- `CONTEXT.md`, domain glossary / ubiquitous language.
- `CLAUDE.md`, AI agent instructions (symlink to `AGENTS.md`).
- `AGENTS.md`, repo-specific agent notes.
