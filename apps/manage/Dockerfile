# Multi-stage build for manage (React/Vite static bundle).
# Stage 1 builds the bundle with bun; stage 2 serves it via nginx.
# No API proxy block, unlike apps/web: manage has no backend.

FROM oven/bun:1.2-alpine AS builder

WORKDIR /app

# Install all workspace deps. Copy root manifests first so bun can resolve
# workspace packages before copying source, keeps the layer cache effective.
COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/manage/package.json ./apps/manage/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/temporal-worker/package.json ./apps/temporal-worker/package.json
COPY apps/map-provision/package.json ./apps/map-provision/package.json
COPY apps/storybook/package.json ./apps/storybook/package.json
COPY apps/dont-text-your-ex/package.json ./apps/dont-text-your-ex/package.json
COPY apps/dont-text-your-ex/apps/api/package.json ./apps/dont-text-your-ex/apps/api/package.json
COPY apps/dont-text-your-ex/apps/e2e/package.json ./apps/dont-text-your-ex/apps/e2e/package.json
COPY apps/dont-text-your-ex/apps/frontend/package.json ./apps/dont-text-your-ex/apps/frontend/package.json
COPY apps/dont-text-your-ex/apps/temporal-worker/package.json ./apps/dont-text-your-ex/apps/temporal-worker/package.json
COPY apps/dont-text-your-ex/packages/notifications/package.json ./apps/dont-text-your-ex/packages/notifications/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/logger/package.json ./packages/logger/package.json
COPY packages/platform/package.json ./packages/platform/package.json
COPY packages/temporal-runtime/package.json ./packages/temporal-runtime/package.json
COPY packages/theme/package.json ./packages/theme/package.json
COPY packages/worker-runtime/package.json ./packages/worker-runtime/package.json
# Infra Pulumi workspaces (www-j934.1/.2/.3): root package.json declares these, so
# bun install needs their manifests in the build context (www-272b).
COPY infra/package.json ./infra/package.json
COPY infra/cloudflare/package.json ./infra/cloudflare/package.json
COPY infra/cloudflare/workers/dont-text-your-ex-edge/package.json ./infra/cloudflare/workers/dont-text-your-ex-edge/package.json
COPY infra/unifi/package.json ./infra/unifi/package.json

# --ignore-scripts skips the lefthook prepare hook (needs git, not in alpine image).
RUN bun install --frozen-lockfile --ignore-scripts

# Root tsconfig must be present so workspace tsconfigs can extend it.
COPY tsconfig.json ./tsconfig.json

COPY apps/manage ./apps/manage
# The shared palette (packages/theme) is @imported by manage's stylesheet.
COPY packages/theme ./packages/theme

RUN bun run --cwd apps/manage build


# Stage 2: nginx serves the static bundle.
FROM nginx:1.27-alpine AS runtime

RUN rm /etc/nginx/conf.d/default.conf

COPY apps/manage/nginx.conf /etc/nginx/conf.d/app.conf

COPY --from=builder /app/apps/manage/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
