#!/usr/bin/env bash
set -euo pipefail

ci=.github/workflows/ci.yml
worker_package=apps/dont-text-your-ex/apps/temporal-worker/package.json

require() {
  local pattern=$1
  local file=$2
  if ! grep -Eq -- "$pattern" "$file"; then
    echo "missing DTYE CI contract: $pattern in $file" >&2
    exit 1
  fi
}

# W12.4: the product lane must name the real transaction -> Postgres outbox ->
# Temporal workflow -> activity test explicitly. Relying on a broad Vitest glob
# could silently skip the proof after a config change.
require '"test:postgres-temporal"' "$worker_package"
require 'bun run --cwd apps/dont-text-your-ex/apps/temporal-worker test:postgres-temporal' "$ci"
require 'image: postgres:17-alpine' "$ci"
require 'DATABASE_URL: postgresql://postgres:postgres@127\.0\.0\.1:5432/dont_text_your_ex_test' "$ci"

# W12.15: one product path selects its tests, all three amd64 image producers,
# digest collection, and the production deploy fan-in.
require "- 'apps/dont-text-your-ex/\*\*'" "$ci"
for component in frontend api temporal-worker; do
  require "build-dont-text-your-ex-${component}:" "$ci"
  require "runs-on: ubuntu-24\\.04" "$ci"
  require "www-dont-text-your-ex-${component}" "$ci"
  require "build-dont-text-your-ex-${component}," "$ci"
done
require 'www-dont-text-your-ex-frontend:dont-text-your-ex-frontend' "$ci"
require 'www-dont-text-your-ex-api:dont-text-your-ex-api' "$ci"
require 'www-dont-text-your-ex-temporal-worker:dont-text-your-ex-temporal-worker' "$ci"
require 'bun run --cwd apps/dont-text-your-ex test:e2e' "$ci"

echo "PASS: DTYE CI selects real Postgres+Temporal proof and all product artifacts"
