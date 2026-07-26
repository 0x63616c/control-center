# home-server hardware

Physical parts list for the `home-server` Talos node (`192.168.0.5`, the sole
production machine — see `AGENTS.md` "Infra"). This doc exists so #46 (cooler
fan reporting) and #45 (quieter fans) have a concrete parts list to work from
instead of guesswork.

Gathered read-only via `talosctl get <resource>` and `kubectl get nodes -o wide`
against the live node on 2026-07-25. Commands are listed per section so this can
be re-verified or extended later.

## Confirmed remotely

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
(see `AGENTS.md` DSM IP, not this doc).

## Could not determine remotely — needs Calum to read off the physical parts

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
hardware, the fastest way to close this doc out is a phone photo of the case
interior and the PSU label.

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
