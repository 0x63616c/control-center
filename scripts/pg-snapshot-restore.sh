#!/usr/bin/env bash
# Reusable Postgres snapshot + scratch-restore proof tooling (www-jtp0.2.4).
#
# This is platform-era data-safety tooling: production is read-only, scratch is
# the only restore target, and every success path ends with exact per-table row
# counts compared side by side. No secret value is read or printed by this script.

set -euo pipefail

KUBE_CONTEXT="${KUBE_CONTEXT:-home-server}"
NAMESPACE="${NAMESPACE:-control-center}"
DATABASE="${DATABASE:-control_center}"
PGUSER="${PGUSER:-postgres}"
OUTPUT_DIR="${OUTPUT_DIR:-./.pg-snapshots}"
SOURCE_TARGET="production"
SCRATCH_TARGET=""
DRY_RUN=0

usage() {
  sed -n '2,999p' "$0" | sed -n 's/^# \{0,1\}//p'
  cat <<'USAGE'

Usage:
  scripts/pg-snapshot-restore.sh --dry-run --source production --scratch <scratch-cluster>
  scripts/pg-snapshot-restore.sh --source production --scratch <scratch-cluster> --output-dir ./.pg-snapshots
  scripts/pg-snapshot-restore.sh --print-count-sql
  scripts/pg-snapshot-restore.sh --compare-counts <source.tsv> <scratch.tsv>

Env:
  KUBE_CONTEXT=home-server NAMESPACE=control-center DATABASE=control_center PGUSER=postgres
USAGE
}

log() { printf '[pg-snapshot] %s\n' "$*"; }
die() { printf '[pg-snapshot] FATAL: %s\n' "$*" >&2; exit 1; }

read -r -d '' COUNT_SQL <<'SQL' || true
SELECT n.nspname || '.' || c.relname AS qname,
       (xpath('/row/c/text()',
         query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
                      false, true, '')))[1]::text::bigint AS rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_%'
ORDER BY qname
SQL

target_cluster() {
  case "$1" in
    production|control-center) printf 'control-center' ;;
    "") die "target name is required" ;;
    *) printf '%s' "$1" ;;
  esac
}

guard_scratch_target() {
  local scratch="$1"
  case "$scratch" in
    ""|production|control-center)
      die "scratch target must not be production or control-center"
      ;;
  esac
}

primary_pod() {
  local cluster="$1"
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get pods \
    -l "cnpg.io/cluster=$cluster,cnpg.io/instanceRole=primary" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null
}

run_sql() {
  local cluster="$1" sql="$2" pod
  pod="$(primary_pod "$cluster")"
  [ -n "$pod" ] || die "no CNPG primary pod for cluster $cluster in namespace $NAMESPACE"
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" exec -i "$pod" -c postgres -- \
    psql -U "$PGUSER" -d "$DATABASE" -At -F'|' -c "$sql"
}

capture_counts() {
  local cluster="$1" file="$2"
  run_sql "$cluster" "$COUNT_SQL" | sort >"$file"
  [ -s "$file" ] || die "row-count capture was empty: $file"
}

compare_counts() {
  local source_file="$1" scratch_file="$2" tmp source_sorted scratch_sorted
  [ -s "$source_file" ] || die "source counts file missing or empty: $source_file"
  [ -s "$scratch_file" ] || die "scratch counts file missing or empty: $scratch_file"
  tmp="$(mktemp -d)"
  trap "rm -rf '$tmp'" RETURN
  source_sorted="$tmp/source.tsv"
  scratch_sorted="$tmp/scratch.tsv"
  sort "$source_file" >"$source_sorted"
  sort "$scratch_file" >"$scratch_sorted"

  log "side-by-side counts: table | source | scratch"
  join -t'|' -a1 -a2 -e 'MISSING' -o '0,1.2,2.2' "$source_sorted" "$scratch_sorted" \
    | awk -F'|' '{printf "%s|%s|%s%s\n", $1, $2, $3, ($2==$3?"":"|MISMATCH")}'

  if diff -q "$source_sorted" "$scratch_sorted" >/dev/null; then
    log "COUNTS MATCH"
  else
    die "STOP: row-count mismatch; do not cut over or proceed with data migration"
  fi
}

dry_run_plan() {
  local source_cluster scratch_cluster
  source_cluster="$(target_cluster "$SOURCE_TARGET")"
  guard_scratch_target "$SCRATCH_TARGET"
  scratch_cluster="$(target_cluster "$SCRATCH_TARGET")"

  log "dry run only, no commands executed"
  log "source cluster: $source_cluster"
  log "scratch cluster: $scratch_cluster"
  log "output dir: $OUTPUT_DIR"
  log "capture source row counts -> $OUTPUT_DIR/source-counts.tsv"
  log "custom-format dump: pg_dump -Fc -U $PGUSER -d $DATABASE > $OUTPUT_DIR/$DATABASE.dump"
  log "plain gzip dump: pg_dump --format=plain -U $PGUSER -d $DATABASE | gzip -c > $OUTPUT_DIR/$DATABASE.sql.gz"
  log "restore custom dump into scratch with pg_restore --clean --if-exists --no-owner --no-acl"
  log "capture scratch row counts -> $OUTPUT_DIR/scratch-counts.tsv"
  log "compare source and scratch counts side by side"
}

run_snapshot_restore() {
  local source_cluster scratch_cluster source_pod scratch_pod custom_dump plain_dump source_counts scratch_counts
  source_cluster="$(target_cluster "$SOURCE_TARGET")"
  guard_scratch_target "$SCRATCH_TARGET"
  scratch_cluster="$(target_cluster "$SCRATCH_TARGET")"
  mkdir -p "$OUTPUT_DIR"

  custom_dump="$OUTPUT_DIR/$DATABASE.dump"
  plain_dump="$OUTPUT_DIR/$DATABASE.sql.gz"
  source_counts="$OUTPUT_DIR/source-counts.tsv"
  scratch_counts="$OUTPUT_DIR/scratch-counts.tsv"
  source_pod="$(primary_pod "$source_cluster")"
  scratch_pod="$(primary_pod "$scratch_cluster")"
  [ -n "$source_pod" ] || die "no source primary pod for cluster $source_cluster"
  [ -n "$scratch_pod" ] || die "no scratch primary pod for cluster $scratch_cluster"

  log "capture source row counts"
  capture_counts "$source_cluster" "$source_counts"
  log "write custom-format dump"
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" exec -i "$source_pod" -c postgres -- \
    pg_dump -Fc -U "$PGUSER" -d "$DATABASE" >"$custom_dump"
  [ -s "$custom_dump" ] || die "custom-format dump is empty: $custom_dump"
  log "write plain SQL gzip dump"
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" exec -i "$source_pod" -c postgres -- \
    pg_dump --format=plain -U "$PGUSER" -d "$DATABASE" | gzip -c >"$plain_dump"
  [ -s "$plain_dump" ] || die "plain SQL gzip dump is empty: $plain_dump"
  log "restore custom dump into scratch"
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" exec -i "$scratch_pod" -c postgres -- \
    pg_restore -U "$PGUSER" -d "$DATABASE" --clean --if-exists --no-owner --no-acl <"$custom_dump"
  log "capture scratch row counts"
  capture_counts "$scratch_cluster" "$scratch_counts"
  compare_counts "$source_counts" "$scratch_counts"
}

if [ "$#" -eq 0 ]; then
  usage
  exit 2
fi

case "${1:-}" in
  --print-count-sql)
    printf '%s\n' "$COUNT_SQL"
    exit 0
    ;;
  --compare-counts)
    [ "$#" -eq 3 ] || die "--compare-counts requires <source.tsv> <scratch.tsv>"
    compare_counts "$2" "$3"
    exit 0
    ;;
  -h|--help)
    usage
    exit 0
    ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --source) SOURCE_TARGET="${2:-}"; shift 2 ;;
    --scratch) SCRATCH_TARGET="${2:-}"; shift 2 ;;
    --output-dir) OUTPUT_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done

if [ "$DRY_RUN" -eq 1 ]; then
  dry_run_plan
else
  run_snapshot_restore
fi
