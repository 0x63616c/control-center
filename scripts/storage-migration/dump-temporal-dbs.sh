#!/usr/bin/env bash
# dump-temporal-dbs.sh — pg_dump every database to the NAS staging dir.
#
# Part of the local-lvm cutover (ADR-0009, docs/runbooks/local-lvm-cutover.md).
#
# THE NIGHTLY pg-backup CRON DUMPS ONLY control_center. The temporal,
# temporal_visibility and home_assistant databases have NO other backup —
# through the cutover wipe, this script's dumps are their only lifeline.
#
# Dumps land in backups/world-wide-webb/storage-migration/<date>/dumps/ via a
# staging pod that mounts the NAS NFS export; every dump is gunzip -t verified
# after upload. Idempotent: re-running overwrites the same dated dir.
#
# Usage: scripts/storage-migration/dump-temporal-dbs.sh [YYYY-MM-DD]
set -euo pipefail

NAS_SERVER="192.168.0.218"
NAS_EXPORT="/volume1/Homelab"
STAGING_DATE="${1:-$(date +%F)}"
STAGING_SUBDIR="backups/world-wide-webb/storage-migration/${STAGING_DATE}"
POD="storage-migration-staging"
NS="kube-system"

# namespace | CNPG primary pod | database
DUMPS="
control-center control-center-postgres-1 control_center
temporal temporal-postgres-1 temporal
temporal temporal-postgres-1 temporal_visibility
home-assistant home-assistant-postgres-1 home_assistant
"

kubectl get nodes >/dev/null || {
  echo "ERROR: kubectl cannot reach the cluster; refusing to run" >&2
  exit 1
}

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
      volumeMounts:
        - { name: nas, mountPath: /nas }
  volumes:
    - name: nas
      nfs: { server: ${NAS_SERVER}, path: ${NAS_EXPORT} }
EOF

kubectl -n "$NS" wait --for=condition=Ready "pod/${POD}" --timeout=120s
kubectl -n "$NS" exec "$POD" -- mkdir -p "/nas/${STAGING_SUBDIR}/dumps"

echo "$DUMPS" | while read -r ns primary db; do
  [ -n "$ns" ] || continue
  out="/nas/${STAGING_SUBDIR}/dumps/${db}.sql.gz"
  echo "Dumping ${ns}/${primary} db=${db} -> ${out}"
  kubectl -n "$ns" exec "$primary" -c postgres -- pg_dump -U postgres -d "$db" \
    | gzip \
    | kubectl -n "$NS" exec -i "$POD" -- sh -c "cat > ${out}"
  kubectl -n "$NS" exec "$POD" -- sh -ec "
    gunzip -t ${out}
    size=\$(wc -c < ${out})
    [ \"\$size\" -gt 1000 ] || { echo 'ERROR: ${db} dump suspiciously small ('\$size' bytes)' >&2; exit 1; }
    echo \"  OK: ${db}.sql.gz \$size bytes, gunzip -t clean\"
  "
done

kubectl -n "$NS" exec "$POD" -- ls -la "/nas/${STAGING_SUBDIR}/dumps"
kubectl -n "$NS" delete pod "$POD" --wait=false

echo "OK: all dumps staged and verified."
