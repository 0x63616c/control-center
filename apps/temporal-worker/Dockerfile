# syntax=docker/dockerfile:1

# The ONE image in this repo whose runtime is Node, not bun.
#
# Two hard constraints force it, both from the Temporal TypeScript SDK:
#   1. @temporalio/core-bridge is a Rust/N-API addon shipped as prebuilt
#      binaries for `x86_64-unknown-linux-gnu` / `aarch64-unknown-linux-gnu`
#      only — there is NO musl build, so the runtime base must be glibc
#      (node:22-slim), never alpine. An alpine base fails at require() time.
#   2. The Workflow sandbox is built on node's `vm` module, and workflow code is
#      bundled at boot by the SDK's own webpack+swc pipeline — so workflows.ts
#      ships as SOURCE and node_modules ships with it.
# bun is still the builder (one lockfile for the whole monorepo).

# ── Stage 1: install + bundle the non-workflow entrypoint ─────────────────────
# oven/bun:1.2 (debian, glibc) NOT :1.2-alpine — node_modules built here is
# copied into the glibc runtime below, so the native addons must match.
FROM oven/bun:1.2 AS build

WORKDIR /app

# Copy every workspace manifest so bun resolves the full graph.
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
COPY infra/package.json infra/
COPY infra/cloudflare/package.json infra/cloudflare/
COPY infra/cloudflare/workers/dont-text-your-ex-edge/package.json infra/cloudflare/workers/dont-text-your-ex-edge/
COPY infra/unifi/package.json infra/unifi/

# --production drops devDependencies (playwright, vitest, biome…) so the
# node_modules copied into the runtime stage stays close to what the worker
# actually loads. --ignore-scripts skips the lefthook prepare hook (needs git).
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY apps/temporal-worker apps/temporal-worker
COPY packages packages
# ADR-0008 authoring surface: workflows/activities live in-feature and reach the
# worker through the generated barrels in features/_generated/.
COPY app-kit app-kit
COPY features features

# Bundle only the NON-workflow entrypoint (--target=node: it runs under node).
# Workflow code (features/*/workflows.ts via the generated barrel) is
# deliberately excluded from this bundle — see the header.
#
# `cd apps/temporal-worker` first: bun build resolves the `@app-kit` alias via
# the nearest tsconfig's `paths`, and the ROOT tsconfig is deliberately
# paths-free (mirrors apps/worker/Dockerfile).
#
# `--external '@temporalio/*'`: the SDK is NOT bundleable. @temporalio/worker
# pulls in webpack + swc-loader, whose lazy `require("loader-utils")` /
# `require("@swc/wasm")` fallbacks a static bundler cannot resolve, and the
# native bridge is a .node addon anyway. It resolves from the node_modules this
# image ships. Everything of OURS (and pino) still bundles in.
#
# `.mjs`, not `.js`: the bundle is ESM and the runtime image ships no
# package.json at /app, so node would otherwise parse it as CommonJS and die on
# the first `import`.
RUN cd apps/temporal-worker && bun build src/index.ts --target=node \
      --external '@temporalio/*' --outfile ../../dist/index.mjs

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

WORKDIR /app

# node_modules is needed at RUNTIME, not just build: the SDK bundles workflow
# code on boot (webpack + swc + the native bridge all load from here).
COPY --from=build /app/node_modules node_modules
# The image mirrors the REPO layout — apps/temporal-worker/src next to
# features/ — so index.ts's relative `../../../features/_generated/…` hops
# (the workflowsPath handed to the SDK bundler) resolve identically here and
# in local dev. The workflow import graph ships as SOURCE: the SDK's own
# webpack+swc pipeline compiles it at boot.
COPY --from=build /app/features features
COPY --from=build /app/apps/temporal-worker/src apps/temporal-worker/src
COPY --from=build /app/dist/index.mjs apps/temporal-worker/src/index.mjs

# The worker dials OUT to temporal-server:7233; its only listener is the
# Prometheus exposition on :9464 (#214), scraped by pod IP in-cluster.
CMD ["node", "apps/temporal-worker/src/index.mjs"]
