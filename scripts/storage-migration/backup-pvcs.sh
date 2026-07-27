#!/usr/bin/env bash
# backup-pvcs.sh — rsync every local-path PVC directory to the NAS staging dir.
#
# Part of the local-lvm cutover (ADR-0009, docs/runbooks/local-lvm-cutover.md).
# Runs a privileged pod that mounts the node's local-path data dir READ-ONLY
# plus the NAS NFS export, and rsyncs every pvc-* directory into
#   backups/world-wide-webb/storage-migration/<date>/pvc-files/
#
# Idempotent: re-running re-syncs into the same dated dir (pass the date as $1
# to target an existing staging dir, default today).
#
# Usage: scripts/storage-migration/backup-pvcs.sh [YYYY-MM-DD]
set -euo pipefail

NAS_SERVER="192.168.0.218"
NAS_EXPORT="/volume1/Homelab"
STAGING_DATE="${1:-$(date +%F)}"
STAGING_SUBDIR="backups/world-wide-webb/storage-migration/${STAGING_DATE}"
LOCAL_PATH_DIR="/opt/local-path-provisioner"
POD="storage-migration-backup"
NS="kube-system"

kubectl get nodes >/dev/null || {
  echo "ERROR: kubectl cannot reach the cluster; refusing to run" >&2
  exit 1
}

echo "Staging dir: ${NAS_EXPORT}/${STAGING_SUBDIR}/pvc-files (server ${NAS_SERVER})"

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
    - name: rsync
      image: instrumentisto/rsync-ssh:alpine
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

kubectl -n "$NS" exec "$POD" -- sh -ec "
  mkdir -p /nas/${STAGING_SUBDIR}/pvc-files
  ls -d /data/pvc-* >/dev/null 2>&1 || { echo 'ERROR: no pvc-* dirs under ${LOCAL_PATH_DIR}' >&2; exit 1; }
  rsync -a --delete --stats /data/ /nas/${STAGING_SUBDIR}/pvc-files/
  echo '--- synced PVC dirs:'
  du -sh /nas/${STAGING_SUBDIR}/pvc-files/pvc-* | sed 's|.*/||;s|^|  |' || true
  du -sh /nas/${STAGING_SUBDIR}/pvc-files/pvc-*
"

kubectl -n "$NS" delete pod "$POD" --wait=false

echo "OK: PVC files staged. Verify the listing above matches 'kubectl get pvc -A' (RWO claims)."
