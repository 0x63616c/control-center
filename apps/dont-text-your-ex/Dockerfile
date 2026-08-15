# Text Your Ex - single-image build. Builds the web app, serves it + the API from Bun.
FROM oven/bun:1.2.19 AS build
WORKDIR /app

# install deps (web + server + root)
COPY package.json bun.lock ./
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/e2e/package.json apps/e2e/package.json
RUN bun install --frozen-lockfile

# build the web app
COPY . .
RUN bun run --cwd apps/frontend build

# ── runtime image ──
FROM oven/bun:1.2.19 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
# bring over installed deps + built artifacts + server source
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/frontend/dist ./apps/frontend/dist
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/package.json ./package.json

# persistent sqlite lives here
ENV TYE_DB=/app/data/tye.sqlite
VOLUME ["/app/data"]

EXPOSE 8787
CMD ["bun", "run", "apps/api/src/index.ts"]
