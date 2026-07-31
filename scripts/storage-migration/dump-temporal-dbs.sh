#!/usr/bin/env bash
# dump-temporal-dbs.sh — pg_dump every database to the NAS staging dir.
#
# Part of the local-lvm cutover (ADR-0009, docs/runbooks/local-lvm-cutover.md).
#
# THE NIGHTLY product backup CronJobs dump control_center and software_factory.
# The temporal, temporal_visibility, and home_assistant databases have NO other
# backup — through the cutover wipe, this script's dumps are their only lifeline.
#
# Data path: pg_dump|gzip runs INSIDE each CNPG primary, writing onto its own
# PVC (node disk); a hostPath+NFS pod then copies node-side to the NAS and
# gunzip -t verifies there. Nothing large ever streams through `kubectl exec -i`
# — the API-server websocket silently truncates multi-hundred-MB stdin streams
# (observed: 100MB in, 0 bytes out, rc=0).
#
# Dumps land in backups/world-wide-webb/storage-migration/<date>/dumps/.
# Idempotent: re-running overwrites the same dated dir.
#
# Usage: scripts/storage-migration/dump-temporal-dbs.sh [YYYY-MM-DD]
set -euo pipefail

NAS_SERVER="192.168.0.218"
NAS_EXPORT="/volume1/Homelab"
STAGING_DATE="${1:-$(date +%F)}"
STAGING_SUBDIR="backups/world-wide-webb/storage-migration/${STAGING_DATE}"
LOCAL_PATH_DIR="/opt/local-path-provisioner"
POD="storage-migration-staging"
NS="kube-system"

# namespace/CNPG-primary-pod/database
DUMPS=(
  control-center/control-center-postgres-1/control_center
  software-factory/software-factory-postgres-1/software_factory
  temporal/temporal-postgres-1/temporal
  temporal/temporal-postgres-1/temporal_visibility
  home-assistant/home-assistant-postgres-1/home_assistant
)

kubectl get nodes >/dev/null || {
  echo "ERROR: kubectl cannot reach the cluster; refusing to run" >&2
  exit 1
}

# 1. Dump inside each primary, onto its own PVC (mounted at
# /var/lib/postgresql/data — the dump file sits next to, not inside, pgdata).
for entry in "${DUMPS[@]}"; do
  ns="${entry%%/*}"
  rest="${entry#*/}"
  primary="${rest%%/*}"
  db="${rest#*/}"
  echo "Dumping ${ns}/${primary} db=${db} (on-PVC)"
  kubectl -n "$ns" exec "$primary" -c postgres -- sh -ec "
    pg_dump -U postgres -d ${db} | gzip > /var/lib/postgresql/data/dump_${db}.sql.gz
    gunzip -t /var/lib/postgresql/data/dump_${db}.sql.gz
    wc -c < /var/lib/postgresql/data/dump_${db}.sql.gz
  "
done

# 2. Copy node-side from the local-path PVC dirs to the NAS, verify, clean up.
kubectl -n "$NS" delete pod "$POD" --ignore-not-found --wait=true
kubectl -n "$NS" apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${POD}
  labels: { app: storage-migration }
spec:
  restartPolicy: Never
  containers:
    - name: staging
      image: alpine:3.20
      command: ["sleep", "3600"]
      securityContext:
        privileged: true
      volumeMounts:
        - { name: local-path-data, mountPath: /data, readOnly: true }
        - { name: nas, mountPath: /nas }
  volumes:
    - name: local-path-data
      hostPath: { path: ${LOCAL_PATH_DIR}, type: Directory }
    - name: nas
      nfs: { server: ${NAS_SERVER}, path: ${NAS_EXPORT} }
EOF
kubectl -n "$NS" wait --for=condition=Ready "pod/${POD}" --timeout=120s

for entry in "${DUMPS[@]}"; do
  ns="${entry%%/*}"
  rest="${entry#*/}"
  primary="${rest%%/*}"
  db="${rest#*/}"
  # home_assistant and the newly declared, still-empty software_factory
  # database are legitimately near-empty. HA's recorder writes SQLite in the
  # ha-config PVC (rsynced by backup-pvcs.sh); every other database must have a
  # meaningful dump.
  min_size=1000
  case "$db" in
    home_assistant | software_factory) min_size=200 ;;
  esac
  kubectl -n "$NS" exec "$POD" -- sh -ec "
    mkdir -p /nas/${STAGING_SUBDIR}/dumps
    src=\$(ls -d /data/pvc-*_${ns}_${primary%-1}-1 2>/dev/null | head -1)
    [ -n \"\$src\" ] || { echo 'ERROR: no local-path dir for ${ns}/${primary}' >&2; exit 1; }
    cp \"\$src/dump_${db}.sql.gz\" /nas/${STAGING_SUBDIR}/dumps/${db}.sql.gz
    gunzip -t /nas/${STAGING_SUBDIR}/dumps/${db}.sql.gz
    size=\$(wc -c < /nas/${STAGING_SUBDIR}/dumps/${db}.sql.gz)
    [ \"\$size\" -gt ${min_size} ] || { echo 'ERROR: ${db} dump suspiciously small ('\$size' bytes)' >&2; exit 1; }
    echo \"  OK: ${db}.sql.gz \$size bytes, gunzip -t clean on NAS\"
  "
  # Remove the on-PVC dump now that it is verified on the NAS.
  kubectl -n "$ns" exec "$primary" -c postgres -- rm -f "/var/lib/postgresql/data/dump_${db}.sql.gz"
done

kubectl -n "$NS" exec "$POD" -- ls -la "/nas/${STAGING_SUBDIR}/dumps"
kubectl -n "$NS" delete pod "$POD" --wait=false

echo "OK: all dumps staged and verified."
