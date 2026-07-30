#!/usr/bin/env bash
# Guard (Track C, C7): the `@app-kit` / `@app-kit/server` / `@features` authoring-
# surface aliases must be declared IDENTICALLY in every resolver that carries
# them, or a module resolves in one tool and not another (tsc green, vite build
# red — or worse, silently divergent code). Wired into CI (test-unit job).
#
# The test/scripts/alias-parity.test.ts vitest case proves the aliases RESOLVE at runtime; this
# script is the static backstop that every resolver CONFIG still carries the
# mapping, so a dropped alias fails fast in CI regardless of whether a test
# happens to import through it.
#
# Resolvers checked (the 8 that declare these aliases; verified by grep against
# the live tree — not every config declares every alias, this list matches what
# each config actually needs):
#   tsconfig `paths` style (keys like "@app-kit": / "@app-kit/server": / "@features/*":)
#     - tsconfig.config.json      (app-kit/ + features/ + the alias-parity proof)
#     - apps/web/tsconfig.json    (web consumers; own `paths`, restated)
#     - apps/api/tsconfig.json    (api consumes folded features via @features,
#                                  reaches trpc via @app-kit/server)
#     - packages/api/tsconfig.json (@cc/api re-exports apps/api's router types,
#                                  transitively typechecking @app-kit/@features)
#     - features/tsconfig.json    (bun-only resolver for feature source itself)
#   resolve.alias style (keys like "@app-kit": / "@app-kit/server": / "@features":)
#     - apps/web/vite.config.ts
#     - vitest.config.ts          (root; apps-gen inline project)
#     - apps/api/vitest.config.ts
#
# All 8 declare all three aliases. vite/vitest resolvers additionally need
# `@app-kit/server` declared BEFORE `@app-kit` — vite matches a string alias
# when the importee equals it or starts with `alias + "/"`, so a bare
# `@app-kit` entry first would swallow `@app-kit/server`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0

# check_tsconfig <file>: JSON `paths` keys, order-independent.
check_tsconfig() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "✗ MISSING FILE: $file"
    fail=1
    return
  fi
  local ok=1
  if ! grep -Eq '"@app-kit"[[:space:]]*:' "$file"; then
    echo "✗ $file: missing @app-kit alias mapping"
    ok=0
    fail=1
  fi
  if ! grep -Eq '"@app-kit/server"[[:space:]]*:' "$file"; then
    echo "✗ $file: missing @app-kit/server alias mapping"
    ok=0
    fail=1
  fi
  if ! grep -Eq '"@features/\*"[[:space:]]*:' "$file"; then
    echo "✗ $file: missing @features/* alias mapping"
    ok=0
    fail=1
  fi
  if [[ "$ok" == 1 ]]; then
    echo "✓ $file"
  fi
}

# check_resolve_alias <file>: resolve.alias object keys, AND `@app-kit/server`
# must appear (line-order) before the bare `@app-kit` entry.
check_resolve_alias() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "✗ MISSING FILE: $file"
    fail=1
    return
  fi
  local ok=1
  local appkit_line server_line
  appkit_line="$(grep -nE '"@app-kit"[[:space:]]*:' "$file" | head -1 | cut -d: -f1 || true)"
  server_line="$(grep -nE '"@app-kit/server"[[:space:]]*:' "$file" | head -1 | cut -d: -f1 || true)"
  if [[ -z "$appkit_line" ]]; then
    echo "✗ $file: missing @app-kit alias mapping"
    ok=0
    fail=1
  fi
  if [[ -z "$server_line" ]]; then
    echo "✗ $file: missing @app-kit/server alias mapping"
    ok=0
    fail=1
  fi
  if [[ -n "$appkit_line" && -n "$server_line" && "$server_line" -gt "$appkit_line" ]]; then
    echo "✗ $file: @app-kit/server must be declared BEFORE @app-kit (prefix match order)"
    ok=0
    fail=1
  fi
  if ! grep -Eq '"@features"[[:space:]]*:' "$file"; then
    echo "✗ $file: missing @features alias mapping"
    ok=0
    fail=1
  fi
  if [[ "$ok" == 1 ]]; then
    echo "✓ $file"
  fi
}

check_tsconfig "tsconfig.config.json"
check_tsconfig "apps/web/tsconfig.json"
check_tsconfig "apps/api/tsconfig.json"
check_tsconfig "packages/api/tsconfig.json"
check_tsconfig "features/tsconfig.json"

check_resolve_alias "apps/web/vite.config.ts"
check_resolve_alias "vitest.config.ts"
check_resolve_alias "apps/api/vitest.config.ts"

if [[ "$fail" != 0 ]]; then
  echo ""
  echo "Alias parity FAILED: fix the resolver(s) named above so @app-kit /"
  echo "@app-kit/server / @features agree across all 8 configs."
  exit 1
fi

echo ""
echo "✓ Alias parity: @app-kit + @app-kit/server + @features present and"
echo "  correctly ordered across all 8 resolvers."
