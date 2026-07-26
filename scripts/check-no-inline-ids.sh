#!/usr/bin/env bash
# Blocks hand-rolled `prefix_${crypto.randomUUID()}`-shaped IDs outside
# packages/platform/src/id.ts. This repo's ID convention is Stripe-style
# `prefix_<id>` (AGENTS.md), minted through packages/platform's genId() so
# every id-mint site shares one implementation (including the no-crypto
# fallback) instead of re-deriving it ad hoc. See www-184.
#
# Biome cannot express this guard: noRestrictedGlobals only bans bare global
# identifiers, not the `crypto.randomUUID` member expression, and banning
# `crypto` outright would also break legitimate `crypto.subtle` use elsewhere.
# So this is a grep-based CI/pre-commit check, same shape as this repo's other
# grep-based lefthook guards (see lefthook.yml).

set -euo pipefail

is_sanctioned() {
  case "$1" in
    packages/platform/src/id.ts) return 0 ;;
    packages/platform/test/id.test.ts) return 0 ;;
    scripts/check-no-inline-ids.sh) return 0 ;;
    *) return 1 ;;
  esac
}

violations=()

for f in "$@"; do
  is_sanctioned "$f" && continue
  case "$f" in
    node_modules/*|*/node_modules/*|*/dist/*|*/storybook-static/*) continue ;;
  esac
  [ -f "$f" ] || continue

  if grep -nE '`[A-Za-z0-9]+_\$\{[^}]*randomUUID\(\)[^}]*\}' "$f" >/dev/null 2>&1; then
    while IFS= read -r line; do
      violations+=("$f:$line")
    done < <(grep -nE '`[A-Za-z0-9]+_\$\{[^}]*randomUUID\(\)[^}]*\}' "$f")
  fi
done

if [ ${#violations[@]} -gt 0 ]; then
  echo "✗ Hand-rolled prefix_<id> found — use genId() from @www/platform instead:" >&2
  printf '   %s\n' "${violations[@]}" >&2
  echo "" >&2
  echo "   import { genId } from \"@www/platform\";" >&2
  echo "   genId(\"prefix\")              // full crypto.randomUUID()" >&2
  echo "   genId(\"prefix\", { length })  // truncated hex, e.g. an API's ^prefix_[0-9a-z]{1,32}\$" >&2
  exit 1
fi

exit 0
