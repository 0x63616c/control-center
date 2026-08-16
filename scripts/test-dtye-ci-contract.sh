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

job_block() {
  local job=$1
  awk -v header="  $job:" '
    $0 == header { capture=1 }
    capture && $0 != header && /^  [[:alnum:]_-]+:$/ { exit }
    capture { print }
  ' "$ci"
}

filter_block() {
  awk '
    $0 == "            dont_text_your_ex:" { capture=1 }
    capture && $0 != "            dont_text_your_ex:" && /^            [[:alnum:]_-]+:$/ { exit }
    capture { print }
  ' "$ci"
}

require_in_block() {
  local pattern=$1
  local label=$2
  local block=$3
  if ! grep -Eq -- "$pattern" <<<"$block"; then
    echo "missing DTYE CI contract: $pattern in $label" >&2
    exit 1
  fi
}

# W12.4: the product lane must name the real transaction -> Postgres outbox ->
# Temporal workflow -> activity test explicitly. Relying on a broad Vitest glob
# could silently skip the proof after a config change.
require '"test:postgres-temporal"' "$worker_package"
test_job=$(job_block test-dont-text-your-ex)
require_in_block 'needs\.changes\.outputs\.dont_text_your_ex' test-dont-text-your-ex "$test_job"
require_in_block 'bun run --cwd apps/dont-text-your-ex/apps/temporal-worker test:postgres-temporal' test-dont-text-your-ex "$test_job"
require_in_block 'image: postgres:17-alpine' test-dont-text-your-ex "$test_job"
require_in_block 'DATABASE_URL: postgresql://postgres:postgres@127\.0\.0\.1:5432/dont_text_your_ex_test' test-dont-text-your-ex "$test_job"
require_in_block 'bun run --cwd apps/dont-text-your-ex test:e2e' test-dont-text-your-ex "$test_job"

# W12.15: one product path selects its tests, all three amd64 image producers,
# digest collection, and the production deploy fan-in.
product_filter=$(filter_block)
require_in_block "- 'apps/dont-text-your-ex/\*\*'" dont_text_your_ex-filter "$product_filter"
deploy_job=$(job_block deploy-home-server)
for component in frontend api temporal-worker; do
  build_name="build-dont-text-your-ex-${component}"
  build_job=$(job_block "$build_name")
  require_in_block 'needs\.changes\.outputs\.dont_text_your_ex' "$build_name" "$build_job"
  require_in_block 'runs-on: ubuntu-24\.04' "$build_name" "$build_job"
  require_in_block "www-dont-text-your-ex-${component}" "$build_name" "$build_job"
  require_in_block "$build_name," deploy-home-server "$deploy_job"
done
require_in_block 'www-dont-text-your-ex-frontend:dont-text-your-ex-frontend' deploy-home-server "$deploy_job"
require_in_block 'www-dont-text-your-ex-api:dont-text-your-ex-api' deploy-home-server "$deploy_job"
require_in_block 'www-dont-text-your-ex-temporal-worker:dont-text-your-ex-temporal-worker' deploy-home-server "$deploy_job"

echo "PASS: DTYE CI selects real Postgres+Temporal proof and all product artifacts"
