#!/usr/bin/env bash
set -euo pipefail

if git ls-files 'apps/software-factory/**' | grep -q .; then
  echo 'embedded software-factory files remain tracked' >&2
  exit 1
fi

for file in .gitignore package.json biome.json vitest.config.ts knip.jsonc .github/workflows/ci.yml scripts/check.ts; do
  if grep -Eq 'apps/software-factory|softwarefactoryweb|softwarefactory:' "$file"; then
    echo "active embedded software-factory ownership remains in $file" >&2
    exit 1
  fi
done

echo 'embedded software-factory source and build ownership are absent'
