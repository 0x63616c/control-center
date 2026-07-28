# syntax=docker/dockerfile:1

# ── Stage 1: bundle the worker into a single file ────────────────────────────
# Same shape as api/Dockerfile, but the entrypoint is the worker app. The
# worker imports its domain cycles from @control-center/api, so this stage needs the api
# source too; bun bundles the whole graph into one self-contained JS file, so the
# runtime image ships no node_modules and no build toolchain (www-xjba).
FROM oven/bun:1.2-alpine AS build

WORKDIR /app

# Copy every workspace manifest so bun resolves the full graph for the bundler.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/temporal-worker/package.json apps/temporal-worker/
COPY apps/map-provision/package.json apps/map-provision/
COPY apps/storybook/package.json apps/storybook/
COPY packages/api/package.json packages/api/
COPY packages/core/package.json packages/core/
COPY packages/logger/package.json packages/logger/
COPY packages/platform/package.json packages/platform/
COPY packages/theme/package.json packages/theme/
COPY packages/worker-runtime/package.json packages/worker-runtime/
# Infra Pulumi workspaces (www-j934.1/.2/.3): root package.json declares these, so
# bun install needs their manifests in the build context (www-272b).
COPY infra/package.json infra/
COPY infra/cloudflare/package.json infra/cloudflare/
COPY infra/unifi/package.json infra/unifi/

# --ignore-scripts skips the lefthook prepare hook (needs git, absent here).
RUN bun install --frozen-lockfile --ignore-scripts

COPY apps/api apps/api
COPY apps/worker apps/worker
COPY packages packages
# C7 authoring surface: worker drains feature jobs from the folder tree.
COPY app-kit app-kit
COPY features features

# Bundle to a single file. index.ts runs migrations on boot via drizzle-orm's
# runtime migrator (re-exported from @control-center/api), so drizzle-kit never ships.
# `cd apps/worker` first: bun build resolves the `@features/*` alias via the
# nearest tsconfig's `paths`, and the ROOT tsconfig is deliberately paths-free.
# apps/worker/tsconfig.json carries `@features` (S1: the worker now imports
# features/_generated/jobs.gen), so build from there. Mirrors apps/api/Dockerfile.
RUN cd apps/worker && bun build src/index.ts --target=bun --outfile ../../dist/worker.js

# ── Stage 2: runtime image ────────────────────────────────────────────────────
# The bundle, the SQL migration files, and the media toolchain (yt-dlp +
# ffmpeg) the ingest handler shells out to. bun is the runtime; alpine keeps a
# shell for on-box debugging.
FROM oven/bun:1.2-alpine AS runtime

WORKDIR /app

# yt-dlp needs ffmpeg to mux the separate DASH video+audio streams YouTube
# serves above 360p. python3 + pip because yt-dlp is a Python CLI;
# --break-system-packages is required on Alpine's managed Python (PEP 668).
RUN apk add --no-cache ffmpeg python3 py3-pip \
 && pip3 install --break-system-packages yt-dlp \
 && yt-dlp --version \
 && ffmpeg -version | head -1

COPY --from=build /app/dist/worker.js worker.js
# Migrations resolve relative to the bundle's own location (import.meta.url),
# i.e. /app/migrations at runtime, keep this path in sync with WORKDIR. They
# live in api (the schema's home) and are re-exported via @control-center/api.
COPY --from=build /app/apps/api/src/db/migrations migrations

# The only listener is the Prometheus exposition on :9464 (#214), scraped by pod
# IP in-cluster; no EXPOSE is needed for that and no Service fronts it.
CMD ["bun", "worker.js"]
