# syntax=docker/dockerfile:1

# ── Stage 1: bundle the server into a single file ────────────────────────────
# The full workspace install lives ONLY in this stage; it is discarded. We emit
# one self-contained JS bundle (server + tRPC + drizzle + pg), so the runtime
# image ships no node_modules and no build toolchain (drizzle-kit, typescript).
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
# The guest (captive-portal) SPA bundle (Task 4, SDD track 0): the api image
# serves it from GUEST_STATIC_DIR via the guest listener (ADR-0006), so the
# built dist-portal/ output has to be baked in here, not just the web image.
# Needs the web product's full source + tsconfig (vite.portal.config.ts,
# portal.html, src/portal/) to build.
COPY apps/web apps/web
COPY tsconfig.json tsconfig.json
COPY packages packages
# C7 authoring surface: api mounts feature routers + schema from the folder tree.
COPY app-kit app-kit
COPY features features

# Bundle to a single file. server.ts runs migrations on boot via drizzle-orm's
# runtime migrator, so drizzle-kit never ships.
# `cd apps/api` first: bun build resolves the `@features/*` alias via the nearest
# tsconfig's `paths`, and the ROOT tsconfig is deliberately paths-free (so the
# apps:gen codegen's `@/*` resolution isn't shadowed). apps/api/tsconfig.json
# carries `@features`, so build from there. Mirrors `apps:gen`'s `cd apps/web`.
RUN cd apps/api && bun build src/server.ts --target=bun --outfile ../../dist/server.js

# Guest SPA bundle -> apps/web/dist-portal/, COPYd into the
# runtime image below at /app/portal-dist (GUEST_STATIC_DIR).
RUN bun run --cwd apps/web build:portal

# The worker is a SEPARATE app + image now (worker, control-center-worker),
# no longer bundled here (www-xjba). The api ships server.js only.

# ── Stage 2: runtime image ────────────────────────────────────────────────────
# Only the bundle and the SQL migration files. bun is the runtime; alpine keeps
# a shell for on-box debugging of the wall panel.
FROM oven/bun:1.2-alpine AS runtime

# Git SHA of the build; CI passes --build-arg BUILD_HASH=${github.sha} (mirrors
# the web image). Absent (local docker build) it stays "dev", the env.ts
# default, so routers/health.ts reports what is actually running in prod.
ARG BUILD_HASH=dev
ENV BUILD_HASH=$BUILD_HASH

WORKDIR /app

COPY --from=build /app/dist/server.js server.js
# Migrations resolve relative to the bundle's own location (import.meta.url),
# i.e. /app/migrations at runtime, keep this path in sync with WORKDIR.
COPY --from=build /app/apps/api/src/db/migrations migrations
# Guest SPA bundle; GUEST_STATIC_DIR is set to this path in the k8s WorkloadSpec.
COPY --from=build /app/apps/web/dist-portal portal-dist

EXPOSE 4201

CMD ["bun", "server.js"]
