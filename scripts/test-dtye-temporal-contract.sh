#!/usr/bin/env bash
set -euo pipefail
worker=apps/dont-text-your-ex/apps/temporal-worker/src/config.ts
registry=apps/dont-text-your-ex/apps/temporal-worker/src/registry.ts
infra=infra/src/dont-text-your-ex.ts
ci=.github/workflows/ci.yml
grep -q 'DTYE_TEMPORAL_TASK_QUEUE = "main"' "$worker"
grep -q 'DTYE_TEMPORAL_NAMESPACE = "dont-text-your-ex"' "$worker"
grep -q 'MANAGED_SCHEDULE_PREFIX = "dtye_"' "$registry"
grep -q 'TEMPORAL_TASK_QUEUE: "main"' "$infra"
grep -q 'TEMPORAL_NAMESPACE: DONT_TEXT_YOUR_EX_NAMESPACE' "$infra"
grep -q 'www-dont-text-your-ex-temporal-worker' "$ci"
bun run --cwd apps/dont-text-your-ex/apps/temporal-worker test
bun run test -- dont-text-your-ex
echo "PASS: Don't Text Your Ex Temporal namespace/queue/image contract"
