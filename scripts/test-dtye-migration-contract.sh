#!/usr/bin/env bash
set -euo pipefail

migrations=apps/dont-text-your-ex/apps/api/src/db/migrations
checksums="$migrations/checksums.sha256"

# Applied migrations are immutable. A checksum change would make a restored or
# partially rolled fleet run different SQL under the same migration identity.
shasum -a 256 --check "$checksums"
for migration in "$migrations"/[0-9][0-9][0-9][0-9]_*.sql; do
  if ! grep -Fq -- "  $migration" "$checksums"; then
    echo "migration is missing its immutable checksum: $migration" >&2
    exit 1
  fi
done

# Since the Temporal outbox foundation, new rollout migrations are expand-only.
# Destructive contract migrations require their own later, explicitly reviewed
# phase after old API and worker images are no longer eligible for rollback.
for migration in "$migrations"/0{010..999}_*.sql; do
  [ -e "$migration" ] || continue
  if grep -Eiq -- \
    'DROP[[:space:]]+(TABLE|COLUMN|TYPE)|ALTER[[:space:]]+TABLE[^;]*(RENAME[[:space:]]+(TO|COLUMN)|DROP[[:space:]]+COLUMN)|TRUNCATE[[:space:]]|DELETE[[:space:]]+FROM' \
    "$migration"; then
    echo "destructive SQL is not allowed in expand migration: $migration" >&2
    exit 1
  fi
done

echo "PASS: DTYE applied migrations are immutable and Temporal-era migrations are expand-only"
