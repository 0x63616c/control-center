FROM oven/bun:1.2-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/manage/package.json apps/manage/
COPY apps/worker/package.json apps/worker/
COPY apps/temporal-worker/package.json apps/temporal-worker/
COPY apps/map-provision/package.json apps/map-provision/
COPY apps/webhook-relay/package.json apps/webhook-relay/
COPY apps/storybook/package.json apps/storybook/
COPY packages/api/package.json packages/api/
COPY packages/core/package.json packages/core/
COPY packages/logger/package.json packages/logger/
COPY packages/platform/package.json packages/platform/
COPY packages/theme/package.json packages/theme/
COPY packages/worker-runtime/package.json packages/worker-runtime/
COPY infra/package.json infra/
COPY infra/cloudflare/package.json infra/cloudflare/
COPY infra/unifi/package.json infra/unifi/
RUN bun install --frozen-lockfile --ignore-scripts
COPY apps/webhook-relay apps/webhook-relay
COPY packages/logger packages/logger
COPY packages/platform packages/platform
RUN cd apps/webhook-relay && bun build src/server.ts --target=bun --outfile ../../relay.js
FROM oven/bun:1.2-alpine
WORKDIR /app
RUN addgroup -S relay && adduser -S relay -G relay
COPY --from=build /app/relay.js relay.js
USER relay
CMD ["bun", "relay.js"]
