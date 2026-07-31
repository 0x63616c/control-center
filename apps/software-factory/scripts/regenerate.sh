#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
sqlc generate
go run ./cmd/api openapi > internal/api/openapi.yaml
(cd web && bun run generate:api)
# Run from web/ so bunx resolves the package-local pinned biome
# (web/package.json, web/bun.lock) instead of falling back to whatever
# version it finds walking up from apps/software-factory, which is
# unpinned in CI jobs that only install the web/ lockfile.
(cd web && bunx biome check --write orval.config.js src/api/generated.ts)
