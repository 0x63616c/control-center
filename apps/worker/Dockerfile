# syntax=docker/dockerfile:1

# ── Stage 1: bundle the worker into a single file ────────────────────────────
# Same shape as api/Dockerfile, but the entrypoint is the worker app. The
# worker imports domain cycles from generated App facets and API-owned migration/
# queue infrastructure, so this stage needs both source trees; bun bundles the
# runtime image ships no node_modules and no build toolchain (www-xjba).
FROM oven/bun:1.2-alpine AS build

WORKDIR /app

# Copy every workspace manifest so bun resolves the full graph for the bundler.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/manage/package.json apps/manage/
COPY apps/worker/package.json apps/worker/
COPY apps/temporal-worker/package.json apps/temporal-worker/
COPY apps/map-provision/package.json apps/map-provision/
COPY apps/storybook/package.json apps/storybook/
COPY apps/dont-text-your-ex/package.json apps/dont-text-your-ex/
COPY apps/dont-text-your-ex/apps/api/package.json apps/dont-text-your-ex/apps/api/
COPY apps/dont-text-your-ex/apps/e2e/package.json apps/dont-text-your-ex/apps/e2e/
COPY apps/dont-text-your-ex/apps/frontend/package.json apps/dont-text-your-ex/apps/frontend/
COPY apps/dont-text-your-ex/apps/temporal-worker/package.json apps/dont-text-your-ex/apps/temporal-worker/
COPY apps/dont-text-your-ex/packages/notifications/package.json apps/dont-text-your-ex/packages/notifications/
COPY packages/api/package.json packages/api/
COPY packages/core/package.json packages/core/
COPY packages/logger/package.json packages/logger/
COPY packages/platform/package.json packages/platform/
COPY packages/temporal-runtime/package.json packages/temporal-runtime/
COPY packages/theme/package.json packages/theme/
COPY packages/worker-runtime/package.json packages/worker-runtime/
# Infra Pulumi workspaces (www-j934.1/.2/.3): root package.json declares these, so
# bun install needs their manifests in the build context (www-272b).
COPY infra/package.json infra/
COPY infra/cloudflare/package.json infra/cloudflare/
COPY infra/cloudflare/workers/dont-text-your-ex-edge/package.json infra/cloudflare/workers/dont-text-your-ex-edge/
COPY infra/unifi/package.json infra/unifi/

# --ignore-scripts skips the lefthook prepare hook (needs git, absent here).
RUN bun install --frozen-lockfile --ignore-scripts

COPY apps/api apps/api
COPY apps/worker apps/worker
COPY packages packages
# App authoring surface: worker drains feature jobs and interval cycles from the folder tree.
COPY app-kit app-kit
COPY features features

# Bundle to a single file. index.ts runs migrations on boot via drizzle-orm's
# runtime migrator (re-exported from @control-center/api), so drizzle-kit never ships.
# `cd apps/worker` first: bun build resolves the `@features/*` alias via the
# nearest tsconfig's `paths`, and the ROOT tsconfig is deliberately paths-free.
# apps/worker/tsconfig.json carries `@features` for the generated jobs and worker
# aggregates, so build from there. Mirrors apps/api/Dockerfile.
RUN cd apps/worker && bun build src/index.ts --target=bun --outfile ../../dist/worker.js

# ── Stage 2: runtime image ────────────────────────────────────────────────────
# The bundle and SQL migration files ship with the Bun runtime; Alpine keeps a
# shell for on-box debugging.
FROM oven/bun:1.2-alpine AS runtime

WORKDIR /app

COPY --from=build /app/dist/worker.js worker.js
# Migrations resolve relative to the bundle's own location (import.meta.url),
# i.e. /app/migrations at runtime, keep this path in sync with WORKDIR. They
# live in api (the schema's home) and are re-exported via @control-center/api.
COPY --from=build /app/apps/api/src/db/migrations migrations

# The only listener is the Prometheus exposition on :9464 (#214), scraped by pod
# IP in-cluster; no EXPOSE is needed for that and no Service fronts it.
CMD ["bun", "worker.js"]
