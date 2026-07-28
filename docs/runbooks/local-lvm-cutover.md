# Runbook: local-lvm cutover (ADR-0009)

> **EXECUTED 2026-07-27.** Kept for the record and for any future
> re-provision. Reality diverged from the plan in ways now folded into the
> steps below, the scripts, and the code — the biggest: `talosctl reset
> --system-labels-to-wipe EPHEMERAL` only REFORMATS the partition (Talos
> adopts the existing 998GB partition; maxSize applies at provision only).
> The working path: wipe STATE+EPHEMERAL → node boots MAINTENANCE MODE (boot
> partitions intact, DHCP reservation keeps .5) → both partitions are gone →
> `talosctl apply-config --insecure` → Talos provisions EPHEMERAL at the cap
> + the raw volume (partition label is `r-storage`: Talos prefixes raw
> volumes with `r-`). Post-restore: `DROP SCHEMA public CASCADE` +
> restore-as-superuser leaves the new schema unreadable to the app user —
> `ALTER SCHEMA public OWNER TO <appuser>; GRANT ALL ON SCHEMA public TO
> <appuser>;` afterwards (temporal + temporal_visibility). Never stream
> dumps through `kubectl exec -i` (silent truncation ~100MB); restores run
> psql over the cluster network from an NFS-mounted pod.

One-time full-cluster rebuild that replaces local-path with OpenEBS LocalPV-LVM.
etcd lives on EPHEMERAL and the EPHEMERAL cap only applies at re-provision, so
this wipes ALL cluster state and rebuilds from `pulumi up` + backups — the same
motion as the 2026-07-25 homelab→home-server cutover.

**There is no rollback past step 4.** The old EPHEMERAL (and etcd) is gone the
moment the reset runs; recovery from any later failure is the same restore path
onto whatever storage exists. That is why step 1's verification is mandatory,
not ceremonial.

Every command runs from the repo root of the accumulated branch
(`issue-282-local-lvm-storage`) unless noted. `TALOSCONFIG=$PWD/infra/talos/clusterconfig/talosconfig`
(regenerate with `talhelper genconfig` from `infra/talos/`).

## 0. Preconditions

- [ ] Calum physically home — a wedged boot needs hands on the machine; there
      is NO remote power-cycle path.
- [ ] Panel/house users warned: the whole house stack (HA, panel, Plex,
      cameras, guest wifi portal) is DOWN for the window.
- [ ] `git status` clean in every worktree; no unmerged work racing this.
- [ ] The accumulated PR (Tasks 2–6) is green but **NOT merged yet**.
- [ ] NAS reachable: `showmount -e 192.168.0.218` lists `/volume1/Homelab`.

## 1. Fresh backups (hard gate)

- [ ] `scripts/storage-migration/backup-pvcs.sh` — rsyncs every local-path
      PVC dir to `backups/world-wide-webb/storage-migration/<date>/pvc-files/`.
- [ ] `scripts/storage-migration/dump-temporal-dbs.sh` — pg_dumps
      control_center, temporal, temporal_visibility, home_assistant into
      `<date>/dumps/`. **The nightly pg-backup cron covers ONLY
      control_center; these dumps are the other three databases' only
      lifeline.**
- [ ] VERIFY (all must pass before anything destructive):
  - every dump file size > 0 and `gunzip -t` clean (the dump script asserts
    this — eyeball its output anyway);
  - the `pvc-files/` listing matches the RWO claims in `kubectl get pvc -A`;
  - spot-`head` one rsync'd file (e.g. a grafana.db or a maps tile) to prove
    real bytes landed.

## 2. Scale down stateful writers

- [ ] `kubectl -n control-center scale deploy api worker web --replicas=0`
- [ ] `kubectl -n temporal scale deploy temporal-worker --replicas=0`
- [ ] CNPG clusters stay RUNNING (the dumps in step 1 already ran, but leave
      the databases quiescent, not deleted — the wipe handles teardown).

## 3. Merge the accumulated branch

- [ ] Merge the Tasks 2–6 PR into `main` NOW — not before the window. CI will
      run and its deploy will partially fail or be raced by the wipe below;
      that is accepted. The authoritative apply is step 7's manual `pulumi up`.

## 4. Apply machine config + wipe (POINT OF NO RETURN)

- [ ] `cd infra/talos && talhelper genconfig`
- [ ] `talosctl apply-config --file clusterconfig/prod-home-server.yaml`
      (contains the EPHEMERAL 200GiB cap + raw `storage` partition docs).
- [ ] `talosctl reset --system-labels-to-wipe EPHEMERAL --reboot`
      STATE/META survive (node identity, machine config); **etcd content does
      not** — the cluster comes back EMPTY.

## 5. Re-bootstrap

- [ ] Wait for the node to answer: `talosctl version` (may take a few minutes).
- [ ] `talosctl bootstrap`
- [ ] `talosctl kubeconfig` (refresh credentials), then wait for
      `kubectl get nodes` → Ready.
- [ ] Confirm partitions: `talosctl get discoveredvolumes` — EPHEMERAL
      ~200GiB, raw `storage` partition ~730GiB.

## 6. Create the volume group

- [ ] `kubectl apply -f scripts/storage-migration/vg-bootstrap.yaml`
- [ ] `kubectl -n kube-system wait --for=jsonpath='{.status.phase}'=Succeeded pod/vg-bootstrap --timeout=180s`
- [ ] `kubectl -n kube-system logs vg-bootstrap` — `vgs` shows VG `storage`,
      ~730g size, ~730g free, 0 LVs.
- [ ] `kubectl -n kube-system delete pod vg-bootstrap`

## 7. Rebuild the cluster

- [ ] From `infra/`: `pulumi up --stack home-server` (main is merged, so this
      is the homelab-cutover motion: namespaces, ESO + vault secrets, CNPG
      operator + clusters on `local-lvm`, temporal, observability, workloads,
      lvm-localpv operator + StorageClass all recreate).
      The CI deploy needs digest pins; if this manual up complains about
      `wwwinfra:imageDigests`, re-run the last green main CI deploy job
      instead, or set the pins from the pre-wipe values.
- [ ] `infra/cloudflare` needs NO re-up (separate project; tunnel config
      unchanged — the connector reconnects when cloudflared pods return).

## 8. Restore data

- [ ] Wait: CNPG primaries Ready (`kubectl get cluster -A`), temporal
      schema-setup Jobs Complete.
- [ ] Postgres (order matters: schema jobs FIRST for temporal):
      `gunzip -c dumps/<db>.sql.gz | kubectl -n <ns> exec -i <primary> -c postgres -- psql -U postgres -d <db>`
      for control_center, temporal, temporal_visibility, home_assistant
      (fetch dumps from the NAS staging dir).
- [ ] File PVCs: `scripts/storage-migration/restore-pvcs.sh <date>` (workloads
      that mount them should still be at 0 replicas / not yet scaled).
- [ ] Scale consumers back up / restart: api, worker, web, temporal-worker,
      home-assistant, grafana, prometheus, loki, plex.

## 9. Verification checklist (all must pass)

- [ ] `kubectl get sc` → ONLY `local-lvm`, marked default.
- [ ] `kubectl get pvc -A` → all Bound with the ADR-0009 plan sizes.
- [ ] `kubectl -n control-center exec control-center-postgres-1 -c postgres -- df -h /var/lib/postgresql/data`
      → shows ~10G, **NOT 929G — the whole point**.
- [ ] Row-count spot-checks vs pre-dump numbers, e.g.
      `select count(*) from incoming_webhook;` in control_center.
- [ ] Enforcement proof: scratch 1Gi PVC + pod,
      `dd if=/dev/zero of=/mnt/f bs=1M count=2000` → FAILS with ENOSPC ~1Gi.
      Delete the scratch PVC after.
- [ ] Prometheus has `kubelet_volume_stats_capacity_bytes` for local-lvm PVCs.
- [ ] Temporal schedules reconciled: temporal-worker logs `declared=5`;
      health-check runs green.
- [ ] Panel/board loads; Plex answers; HA answers on :8123.

## 10. Close out

- [ ] After 7 days green: delete the NAS staging dir.
- [ ] Update `docs/observability.md` — #212's local-path caveat paragraph is
      obsolete (kubelet stats now cover local volumes).
- [ ] Comment + close #282, and note on #212 that the local-path gap closed,
      with verification evidence.
- [ ] Update memory (local-path notes superseded); ADR-0009 gets a one-line
      "Executed YYYY-MM-DD" postscript.
