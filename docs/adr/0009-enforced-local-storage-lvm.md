# Local storage is enforced: OpenEBS LocalPV-LVM on a dedicated partition replaces local-path

Every local PVC on `home-server` is an LVM logical volume in volume group `storage`, provisioned
by OpenEBS LocalPV-LVM through the `local-lvm` StorageClass. A PVC's declared size is its real
size: writes fail with ENOSPC at the limit, expansion is a one-line PVC edit applied online, and
`kubelet_volume_stats_*` metrics exist for every volume. local-path-provisioner is deleted
entirely.

local-path made capacity a fiction. Its "volumes" are plain hostPath directories under
`/opt/local-path-provisioner`, so a 5Gi PVC sees the node's whole 929GB disk — no enforcement, no
usage stats, and expansion is a silent no-op (both upstream wontfix:
[local-path#21](https://github.com/rancher/local-path-provisioner/issues/21),
[local-path#190](https://github.com/rancher/local-path-provisioner/issues/190)). One runaway
writer can consume the disk out from under etcd, Postgres and the OS at once, with no metric to
warn and no limit to stop it.

## Disk layout

Talos machine config caps the EPHEMERAL partition at **200GiB** and declares the remainder of the
NVMe (~730GiB) as a raw partition labeled `storage`, which backs the LVM volume group of the same
name. The cap is sized from measurement (2026-07-27): EPHEMERAL's residual use once PVC data
moves out is ~38GB — containerd images 11.7GB plus logs, kubelet and etcd ~26GB — so 200GiB
leaves generous headroom for image churn without starving the VG.

The `local-lvm` StorageClass is the cluster's only StorageClass and its default, so a PVC that
names nothing lands on enforced storage. It is **thick-provisioned** on purpose: a 10Gi PVC
reserves 10Gi in the VG. Thin provisioning would reintroduce "capacity is a suggestion" through
the back door — over-commit is exactly the failure mode being removed. Filesystem is xfs,
`allowVolumeExpansion: true`. All local-path PVC data measured 4.3GB total, so honest-but-modest
sizes fit trivially in 730GiB.

The NFS RWX statics on the Synology (`192.168.0.218:/volume1/Homelab`) are untouched — this ADR
covers local storage only.

## Rejected

**Quota hacks on local-path.** XFS project quotas bolted onto local-path's hostPath dirs are
unsupported upstream (wontfix above), leave expansion a no-op, and still produce no volume stats.

**TopoLVM.** The same LVM idea, but its distinguishing feature — capacity-aware scheduling — is a
multi-node concern. On one node it is extra machinery for nothing.

**Longhorn, single replica.** Buys replication a single node cannot use, at the price of iscsi
system extensions, privileged components and a network data path in front of a local disk.

**ZFS (zfs-localpv).** Needs a Talos system extension and a reinstall to add features LVM already
covers here; no snapshot requirement exists to justify it.

## Consequences

**The cutover is a one-time full-cluster rebuild.** etcd lives on EPHEMERAL and EPHEMERAL cannot
shrink online, so applying the cap means wiping it — on a single control-plane node that destroys
all cluster state. The migration is: back up all data → `talosctl reset` → re-bootstrap →
`pulumi up` → restore. Same motion as the 2026-07-25 homelab→home-server cutover, which is the
playbook precedent. Runbook: `docs/runbooks/local-lvm-cutover.md`.

**The EPHEMERAL cap is the one irreversible knob.** Resizing it later means another wipe. Every
other size in the system — any PVC — is an online expansion.

**PVC sizes become real and must be sized honestly.** The declared size is now a hard limit; the
migration plan's size table is the source of truth, and hitting a limit is an expansion, not an
outage.

**Volume metrics finally exist.** `kubelet_volume_stats_capacity_bytes` /
`_used_bytes` cover every local PVC, closing the local-path gap noted in #212's storage
dashboards. Alerting on them remains out of scope, per ADR-0007.
