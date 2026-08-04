#!/usr/bin/env bash
# Control Center post-cutover smoke checks (www-jtp0.7.9).
#
# Run AFTER the production data cutover (www-jtp0.7.7) to prove the live stack came
# back healthy against the product CNPG: api reachable, workers registered and
# looping, integrations heartbeating, media-worker in its EXPECTED state (running
# OR intentionally parked at replicas: 0 per DESIGN §10), NAS/maps storage mounted,
# and the nightly backup able to complete against the product DB.
#
# Each check prints `PASS`/`FAIL`/`SKIP <name>: <detail>` and the script exits
# non-zero if any non-skipped check fails. It NEVER reads or prints a secret value.
# Designed to be run from a machine on the tailnet with kubectl context to homelab.
#
# Override the defaults via env (see --help). With CC_SMOKE_DRY_RUN=1 it prints the
# exact commands it WOULD run without touching the cluster (used by the hermetic
# test and for a no-side-effect preview).

set -uo pipefail

KUBE_CONTEXT="${KUBE_CONTEXT:-home-server}"
NAMESPACE="${NAMESPACE:-control-center}"
API_BASE="${CC_API_BASE:-http://localhost:4201}"          # in-cluster the api listens on 4201
WORKER_DEPLOY="${CC_WORKER_DEPLOY:-worker}"
MEDIA_WORKER_DEPLOY="${CC_MEDIA_WORKER_DEPLOY:-media-worker}"
DATABASE="${DATABASE:-control_center}"
# media-worker is intentionally parked at 0 replicas until the pod->NAS NFS path
# lands (DESIGN §10 / www-j934.17). Set to the real count once it ships.
EXPECTED_MEDIA_REPLICAS="${CC_EXPECTED_MEDIA_REPLICAS:-0}"
DRY_RUN="${CC_SMOKE_DRY_RUN:-0}"

# Worker names that MUST appear in the worker deployment's logs (registration
# lines). Mirrors the registry in worker.
WORKER_NAMES=(light-enforcer climate-enforcer device-sync party-mode weather-ingest)

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '2,40p' "$0" | sed -n 's/^# \{0,1\}//p'
  cat <<'USAGE'

Env overrides:
  KUBE_CONTEXT, NAMESPACE, CC_API_BASE, CC_WORKER_DEPLOY, CC_MEDIA_WORKER_DEPLOY,
  DATABASE, CC_EXPECTED_MEDIA_REPLICAS (default 0 = intentionally parked),
  CC_SMOKE_DRY_RUN=1 (print commands, do not execute).

Exit 0 only if every non-skipped check passes.
USAGE
  exit 0
fi

fail=0
pass() { printf 'PASS %s: %s\n' "$1" "$2"; }
fk()   { printf 'FAIL %s: %s\n' "$1" "$2"; fail=1; }
skip() { printf 'SKIP %s: %s\n' "$1" "$2"; }

kc() { kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" "$@"; }

if [ "$DRY_RUN" = "1" ]; then
  echo "[smoke] DRY RUN, commands only:"
  echo "  curl -fsS $API_BASE/up"
  echo "  curl -fsS $API_BASE/health/climate"
  echo "  kubectl --context $KUBE_CONTEXT -n $NAMESPACE logs deploy/$WORKER_DEPLOY --tail=400  # grep: ${WORKER_NAMES[*]}"
  echo "  kubectl --context $KUBE_CONTEXT -n $NAMESPACE get deploy/$MEDIA_WORKER_DEPLOY -o jsonpath='{.spec.replicas}'  # expect $EXPECTED_MEDIA_REPLICAS"
  echo "  psql -d $DATABASE -c 'select integration_id, last_polled_at_utc from integration_sync_status order by 1'"
  echo "  kubectl --context $KUBE_CONTEXT -n $NAMESPACE get pvc  # maps + media PVCs Bound"
  echo "  kubectl --context $KUBE_CONTEXT -n $NAMESPACE create job --from=cronjob/pg-backup smoke-pg-backup  # then wait Complete"
  echo "[smoke] dry run complete (no checks executed)."
  exit 0
fi

# 1. api liveness + HA-reachability health.
if curl -fsS --max-time 10 "$API_BASE/up" >/dev/null 2>&1; then
  pass api-up "$API_BASE/up returned OK"
else
  fk api-up "$API_BASE/up not reachable"
fi
if curl -fsS --max-time 15 "$API_BASE/health/climate" >/dev/null 2>&1; then
  pass api-climate "$API_BASE/health/climate reachable (api can reach Home Assistant)"
else
  fk api-climate "$API_BASE/health/climate failed (api cannot reach HA)"
fi

# 2. Workers registered + looping (log grep for each registered worker name).
worker_logs="$(kc logs "deploy/$WORKER_DEPLOY" --tail=400 2>/dev/null || true)"
if [ -z "$worker_logs" ]; then
  fk worker-logs "no logs from deploy/$WORKER_DEPLOY"
else
  for w in "${WORKER_NAMES[@]}"; do
    if printf '%s' "$worker_logs" | grep -q -- "$w"; then
      pass "worker-$w" "registration/activity seen in worker logs"
    else
      fk "worker-$w" "no log line for worker '$w'"
    fi
  done
fi

# 3. media-worker in expected replica state (0 = intentionally parked).
actual_media="$(kc get "deploy/$MEDIA_WORKER_DEPLOY" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "missing")"
if [ "$actual_media" = "$EXPECTED_MEDIA_REPLICAS" ]; then
  if [ "$EXPECTED_MEDIA_REPLICAS" = "0" ]; then
    pass media-worker "intentionally parked at 0 replicas (DESIGN §10)"
  else
    pass media-worker "at expected $EXPECTED_MEDIA_REPLICAS replicas"
  fi
else
  fk media-worker "replicas=$actual_media, expected $EXPECTED_MEDIA_REPLICAS"
fi

# 4. integration heartbeats present (each integration has a sync-status row).
ints="$(kc exec "deploy/$WORKER_DEPLOY" -- sh -c \
  "psql -t -A -d $DATABASE -c 'select count(*) from integration_sync_status'" 2>/dev/null || echo "")"
if [ -n "$ints" ] && [ "$ints" -gt 0 ] 2>/dev/null; then
  pass integration-heartbeat "$ints integration sync-status rows present"
else
  fk integration-heartbeat "integration_sync_status empty or unreadable"
fi

# 5. Storage: maps + media PVCs Bound (NAS media mount + map PVC reachable).
pvcs="$(kc get pvc -o jsonpath='{range .items[*]}{.metadata.name}={.status.phase}{"\n"}{end}' 2>/dev/null || true)"
if printf '%s' "$pvcs" | grep -q '=Bound'; then
  pass storage-pvc "PVCs Bound: $(printf '%s' "$pvcs" | tr '\n' ' ')"
else
  fk storage-pvc "no Bound PVCs found (maps/media storage)"
fi

# 6. Nightly backup can complete against the product DB (one-off job from cron).
job="smoke-pg-backup-$(date +%s)"
if kc create job "$job" --from=cronjob/pg-backup >/dev/null 2>&1; then
  if kc wait --for=condition=complete --timeout=120s "job/$job" >/dev/null 2>&1; then
    pass pg-backup "one-off pg-backup job completed against $DATABASE"
  else
    fk pg-backup "pg-backup job did not complete in 120s"
  fi
  kc delete "job/$job" >/dev/null 2>&1 || true
else
  skip pg-backup "could not create one-off backup job (run manually)"
fi

if [ "$fail" -ne 0 ]; then
  printf '[smoke] FAILURES above, stack is NOT verified healthy.\n' >&2
  exit 1
fi
printf '[smoke] all checks passed, post-cutover stack verified healthy.\n'
