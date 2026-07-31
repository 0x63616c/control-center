FROM oven/bun:1.2-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/webhook-relay/package.json apps/webhook-relay/
COPY packages/logger/package.json packages/logger/
COPY packages/platform/package.json packages/platform/
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
