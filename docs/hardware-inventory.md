# Hardware inventory

Physical parts list for the house: the `home-server` Talos node, the network, the
NAS, and the desk. It exists so tickets stop reasoning from unnamed parts — #46
(cooler fan reporting) and #45 (quieter fans) both needed a concrete cooler model.

Server rows were gathered read-only via `talosctl get <resource>` and
`kubectl get nodes -o wide` against the live node on 2026-07-25 (commands at the
bottom). Everything else is Calum's own record of what was bought — model numbers
verbatim, not probed.

## home-server (`192.168.0.5`)

The sole production machine — see `AGENTS.md` "Infra".

### Confirmed remotely

| Component | Value | Source |
| --- | --- | --- |
| Motherboard | MSI PRO Z690-A (board `MS-7D25`), amd64 | `talosctl get systeminformation`; also asserted in `infra/talos/talconfig.yaml` |
| CPU | Intel Core i7-12700KF, 12 cores / 20 threads | `talosctl get cpu` |
| RAM | 32 GiB total: 2× 16 GiB Corsair `CMW32GX4M2E3200C16` (Vengeance LPX, DDR4-3200 CL16), dual-channel, populated in `Controller0-DIMMA2` and `Controller1-DIMMB2` | `talosctl get memorymodules` |
| RAM slots | 4 total, 2 populated, 2 empty (`Controller0-DIMMA1` and `Controller1-DIMMB1` report no manufacturer/model/size) — room to grow to 64 GiB with a matching kit | `talosctl get memorymodules` |
| GPU | NVIDIA RTX 3060 (reports as "GeForce RTX 3060 Lite Hash Rate" — an LHR SKU) | `talosctl get pcidevices`; driver NVRM 595.71.05 per the cutover notes |
| Boot/install disk | Samsung SSD 970 EVO Plus 1TB NVMe, `/dev/nvme0n1`, unencrypted by design (no TPM/SecureBoot/UKI) | `talosctl get disks`; `infra/talos/talconfig.yaml` |
| Onboard NIC | Intel I225-V, 2.5GbE, `enp4s0`, MAC `d8:bb:c1:df:7d:19` | `talosctl get links`, `talosctl get pcidevices` |
| OS / cluster | Talos v1.13.7, Kubernetes v1.36.2, single control-plane | `talosctl version`, `kubectl get nodes -o wide` |
| Extra PCI device | An unidentified "YUAN High-Tech Development" multimedia controller at PCI `0000:05:00.0` (likely a capture card left in the case from a prior build) — not currently used by any workload | `talosctl get pcidevices` |

Only one NVMe drive is visible to Talos (`nvme0n1`, 1TB) — no second data/storage
drive is installed in this machine itself; bulk media storage lives on the NAS
(below).

### Could not determine remotely — needs Calum to read off the physical parts

Talos does not expose any of these to `talosctl`/`kubectl`, and there is no SSH
path to run vendor tools (`lm-sensors`, `dmidecode` for these fields specifically,
etc.) — see `AGENTS.md` "no SSH into home-server":

- **PSU** — model, wattage.
- **Case** — model.
- **CPU cooler** — model (subject of #46 - reporting FAN speed - and #45 -
  quieter fans - so worth confirming exact model, since both tickets currently
  reason from "the cooler" without a name).
- **Case fans** — count, size, model (also #45).
- **RAM physical form factor** — heatspreader/RGB variant, in case a matching
  kit needs sourcing for the empty slots.

If any of these are printed on a receipt, box, or visible on the physical
hardware, the fastest way to close this section out is a phone photo of the case
interior and the PSU label.

## Network

| Component | Value | Notes |
| --- | --- | --- |
| Router / gateway | UniFi Cloud Gateway Fiber | Runs the UniFi network the `guest-wifi` and device-state features talk to |
| WAN | AT&T Fiber, 5 Gbps | Fastest tier AT&T sells at this address |

The onboard NIC on `home-server` is 2.5GbE (see above), so a single host cannot
saturate the 5 Gbps WAN on its own.

## NAS

| Component | Value | Notes |
| --- | --- | --- |
| Enclosure | Synology DiskStation DS420+, 4-bay (B&H `SYDS420P`) | `192.168.0.218` — never `.219`; see `AGENTS.md` |
| Drives | 4× WD Red 4TB `WD40EFAX` — 5400 RPM, SATA 6 Gb/s, 256 MB cache, 3.5" | **SMR**, not CMR |

`WD40EFAX` is the SMR revision of WD Red. SMR rewrites whole shingled zones, so
sustained random writes and RAID rebuilds are markedly slower than the CMR
`WD40EFRX`. Assume slow resilver on any drive replacement, and don't put
write-heavy workloads (databases, Temporal state) on the NAS — those belong on
the node's NVMe via `local-lvm`.

Bulk media storage lives here. Backups and map-extract crons write here too
(`infra/src/crons.ts`).

## Desk

Not part of the cluster — recorded so screenshot/resolution assumptions are
grounded, and so peripherals aren't confused with the wall panel.

| Component | Value |
| --- | --- |
| Dock | OWC Thunderbolt 4 dock — drives the main monitor |
| Monitor | LG 45GX950A-B, 45" UltraGear, 5K2K (5120×2160) |
| Mouse | Logitech MX Master 4 |
| Keyboard | Keychron Q6 Max (QMK configs live in the dotfiles repo) |

The `1366x1024` fixed-size invariant in `AGENTS.md` is the **wall panel**, not this
monitor.

## Commands used

```
export TALOSCONFIG=$PWD/infra/talos/clusterconfig/talosconfig
export KUBECONFIG=$PWD/infra/talos/clusterconfig/hs.kubeconfig
kubectl get nodes -o wide
talosctl version
talosctl get cpu
talosctl get memorymodules
talosctl get disks
talosctl get pcidevices
talosctl get links
talosctl get systeminformation
```

None of these touch secret-bearing resources.
