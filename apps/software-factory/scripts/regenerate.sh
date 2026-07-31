#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
sqlc generate
go run ./cmd/api openapi > internal/api/openapi.yaml
(cd web && bun run generate:api)
bunx biome check --write web/orval.config.js web/src/api/generated.ts
