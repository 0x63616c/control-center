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
COPY apps/worker/package.json apps/worker/
COPY apps/temporal-worker/package.json apps/temporal-worker/
COPY apps/map-provision/package.json apps/map-provision/
COPY apps/storybook/package.json apps/storybook/
COPY packages/api/package.json packages/api/
COPY packages/core/package.json packages/core/
COPY packages/logger/package.json packages/logger/
COPY packages/platform/package.json packages/platform/
COPY packages/worker-runtime/package.json packages/worker-runtime/
COPY infra/package.json infra/
COPY infra/cloudflare/package.json infra/cloudflare/
COPY infra/unifi/package.json infra/unifi/

# --production drops devDependencies (playwright, vitest, biome…) so the
# node_modules copied into the runtime stage stays close to what the worker
# actually loads. --ignore-scripts skips the lefthook prepare hook (needs git).
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY apps/temporal-worker apps/temporal-worker
COPY packages/logger packages/logger
COPY packages/platform packages/platform

# Bundle only the NON-workflow entrypoint (--target=node: it runs under node).
# workflows.ts is deliberately excluded from this bundle — see the header.
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
# The image mirrors the source layout — bundle and workflow source share a
# directory — so `new URL("./workflows.ts", import.meta.url)` in index.ts
# resolves identically here and in local dev.
COPY --from=build /app/apps/temporal-worker/src src
COPY --from=build /app/dist/index.mjs src/index.mjs

# No port: the worker dials OUT to temporal-server:7233 and serves no HTTP.
CMD ["node", "src/index.mjs"]
