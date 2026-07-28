#!/usr/bin/env bash
# restore-pvcs.sh — rsync staged file-PVC contents into the NEW local-lvm PVCs.
#
# Part of the local-lvm cutover (ADR-0009, docs/runbooks/local-lvm-cutover.md,
# step 8). Inverse of backup-pvcs.sh: for each plain-file PVC, run a pod
# mounting the new (empty) local-lvm PVC + the NAS staging dir and rsync the
# matching pvc-files/pvc-*_<ns>_<name> content in.
#
# POSTGRES IS NOT RSYNCED. The CNPG clusters restore from the SQL dumps
# (dump-temporal-dbs.sh) AFTER pulumi up recreates them and — for temporal —
# AFTER the schema-setup Jobs complete:
#   gunzip -c dumps/<db>.sql.gz | kubectl -n <ns> exec -i <primary> -c postgres -- psql -U postgres -d <db>
#
# Idempotent: rsync --delete makes re-runs converge on the staged content.
# Scale the consuming workloads to 0 (or run before first scale-up) so nothing
# writes while the restore runs.
#
# Usage: scripts/storage-migration/restore-pvcs.sh <YYYY-MM-DD> [pvc-name ...]
#   (date = the staging dir written by backup-pvcs.sh; default all file PVCs)
set -euo pipefail

NAS_SERVER="192.168.0.218"
NAS_EXPORT="/volume1/Homelab"
STAGING_DATE="${1:?usage: restore-pvcs.sh <YYYY-MM-DD> [pvc ...]}"
shift || true
STAGING_SUBDIR="backups/world-wide-webb/storage-migration/${STAGING_DATE}"

# namespace/pvc-name for every plain-file PVC (postgres excluded, see header)
ALL_PVCS=(
  control-center/maps
  control-center/plex-config
  db-ui/pgadmin-data
  home-assistant/ha-config
  observability/grafana-data
  observability/prometheus-data
  observability/loki-data
)

kubectl get nodes >/dev/null || {
  echo "ERROR: kubectl cannot reach the cluster; refusing to run" >&2
  exit 1
}

targets=("${ALL_PVCS[@]}")
if [ "$#" -gt 0 ]; then
  targets=()
  for want in "$@"; do
    for entry in "${ALL_PVCS[@]}"; do
      [ "${entry#*/}" = "$want" ] && targets+=("$entry")
    done
  done
fi

for entry in "${targets[@]}"; do
  ns="${entry%%/*}"
  pvc="${entry#*/}"
  pod="restore-${pvc}"
  echo "=== Restoring ${ns}/${pvc}"

  kubectl -n "$ns" get pvc "$pvc" >/dev/null

  kubectl -n "$ns" delete pod "$pod" --ignore-not-found --wait=true
  kubectl -n "$ns" apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${pod}
  labels: { app: storage-migration }
spec:
  restartPolicy: Never
  containers:
    - name: rsync
      image: instrumentisto/rsync-ssh:alpine
      command: ["sleep", "3600"]
      volumeMounts:
        - { name: target, mountPath: /target }
        - { name: nas, mountPath: /nas, readOnly: true }
  volumes:
    - name: target
      persistentVolumeClaim: { claimName: ${pvc} }
    - name: nas
      nfs: { server: ${NAS_SERVER}, path: ${NAS_EXPORT} }
EOF
  kubectl -n "$ns" wait --for=condition=Ready "pod/${pod}" --timeout=300s

  kubectl -n "$ns" exec "$pod" -- sh -ec "
    src=\$(ls -d /nas/${STAGING_SUBDIR}/pvc-files/pvc-*_${ns}_${pvc} 2>/dev/null | head -1)
    [ -n \"\$src\" ] || { echo 'ERROR: no staged dir matching *_${ns}_${pvc}' >&2; exit 1; }
    rsync -a --delete --stats \"\$src/\" /target/
    echo '--- restored:'; du -sh /target
  "

  kubectl -n "$ns" delete pod "$pod" --wait=false
done

echo "OK: file PVCs restored. Postgres restores are separate (see header)."
