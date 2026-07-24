# Homelab migration: Mac mini (HAOS + k3s-in-OrbStack) → gaming PC (Talos bare metal)

**Status:** design, pre-plan. Written 2026-07-24. All times LA local.
**Author:** Claude (session 5435128b), from a brainstorm with Calum.
**Supersedes runtime substrate only.** The application (features/, apps/, packages/)
does not change. This moves the *cluster it runs on* off the mini onto a Talos node,
and folds Home Assistant into that cluster as a container.

---

## 1. Why

Today's prod is a Mac mini running two unrelated stacks that keep taking the house
down:

1. **HAOS** in a qcow2 VM (`~/homeassistant-os/haos.qcow2`, 12 GB) driving every
   smart-home device.
2. **k3s inside OrbStack** running the control-center app stack (api/web/worker/
   go2rtc/plex + cert-manager/CNPG/cloudflared).

The 2026-07-24 HA outage (root cause never found) is the latest of several. The
OrbStack layer is an imperative, hand-managed substrate *underneath* the declarative
Pulumi stack — the same failure shape twice. The design goal is **one declarative
substrate, no hand-managed layer beneath it**, on hardware with a schedulable GPU.

## 2. Target end state

- **Talos Linux**, bare metal, single node, on the gaming PC (i7-12700KF, 32 GB,
  RTX 3060, MSI PRO Z690-A DDR4, 1 TB 970 EVO Plus). Control plane + workloads
  (control-plane `NoSchedule` taint removed).
- Wired **2.5 GbE** to the LAN. **Talos has no WiFi** — non-negotiable, radios are
  not a supported Talos config.
- Every current cluster workload re-declared and running: api, web, worker, go2rtc,
  plex, cert-manager, CNPG, cloudflared, metrics-server.
- **Home Assistant as a container** in the same cluster (`hostNetwork: true`), driving
  all devices exactly as HAOS did.
- **RTX 3060 as a schedulable k8s resource** (Talos NVIDIA extensions + device
  plugin). Plex transcodes on it; Frigate/Whisper/Ollama later.
- Mac mini **retired to cold spare**, never wiped, HAOS qcow2 intact = rollback.
- CI `push-to-main` deploys to the Talos cluster, same as today.
- Repo is the single source of truth: Talos machine config, workloads, secrets all
  checked in. No hand-applied drift.

## 3. What was verified (recon 2026-07-24, do not re-derive)

### Cluster today (context `cc-homelab`)
- Single node `orbstack`, k3s `v1.33.9+orb1`, **inside OrbStack on the mini**, up 211d.
- Namespaces: cert-manager, cnpg-system, control-center, platform, kube-system.
- control-center deployments: **api, web, worker, go2rtc, plex**.
- platform: **cloudflared** (2 replicas) — the external-access tunnel.
- kube-system: coredns, local-path-provisioner, metrics-server, **k3s ServiceLB
  (klipper `svclb-*` daemonsets)** for the `api` and `plex` LoadBalancer services.
- **No Home Assistant in the cluster.** HA is HAOS-in-qcow2 on the mini host.

### Storage (decides what physically moves)
- **NFS PVs to the Synology `192.168.0.218`** — `api-vol`, `worker-vol`, `plex-vol-1`,
  `pg-backup-vol`. **Nothing to move**; the new cluster re-mounts them.
- **local-path PVCs, physically on the mini SSD** — must be recreated/migrated:
  - `control-center-1` (5 Gi) — **CNPG Postgres data. The one irreplaceable local PVC.**
  - `plex-config` (10 Gi) — Plex library/metadata. Nice to keep, not irreplaceable.
  - `maps` (2 Gi) — basemap tiles. **Regenerable** by the `map-extract` cron / web
    initContainer. Do not migrate; let it re-provision.

### Postgres backup reality (corrects a handoff assumption)
- The CNPG `Cluster` spec has **no `backup:` stanza** → **no barman / no PITR**.
- Backup is the daily **`pg-backup` CronJob**: `pg_dump | gzip` → NAS NFS, with
  `set -eo pipefail` so a bad dump fails loudly. Last three runs `Complete`; most
  recent **11h ago**. Backup chain is healthy and fresh.
- Implication: PG recovery = restore the latest daily dump. Migration uses a **fresh
  `pg_dump` at cutover**, not the cron artifact, for a zero-age copy.

### Deploy path (CI → cluster) — the biggest hidden cost
- CI builds images on **`ubuntu-24.04-arm`**, `platforms: linux/arm64` (the shared
  action is literally titled "Build and push ARM64 image"). **Images are arm64-only.**
- Deploy job: joins the tailnet with an **ephemeral `tag:ci` OAuth** identity, reads
  **`KUBECONFIG__B64`** from the SOPS vault, runs `pulumi up --stack prod`.
- The kubeconfig endpoint is `https://homelab.tail8c014d.ts.net:26443`, a
  **`tailscale serve` TCP forward to `127.0.0.1:26443`** on the mini. The kube API
  cert has **no tailnet SAN** (SANs `k8s.orb.local`, `localhost`); the kubeconfig sets
  `tls-server-name: k8s.orb.local`, embeds the **OrbStack CA**, auths with an OrbStack
  client cert/key.
- Pulumi digest-pin namespace is **`wwwinfra:`** (`wwwinfra:imageDigests.<svc>`,
  `wwwinfra:kubeContext`). *(CODEBASE_OVERVIEW.md still says `ccinfra:` — stale;
  AGENTS.md `wwwinfra:` is correct.)*

### HA add-on / recorder reality (corrects a locked decision — see §5)
- HA runs **exactly two add-ons**: Matter Server (empty fabric, zero Matter devices)
  and Advanced SSH terminal (disposable). No add-on dependency to preserve.
- Everything else is core integrations: Hue, Shelly, HomeKit Controller, Apple TV,
  Sonos, Tesla Fleet, Renpho BLE scale, ESPHome, Thread, go2rtc.
- **HAOS recorder is SQLite** (`home-assistant_v2.db` inside `/config`), **not
  Postgres.** The irreplaceable pairing/token state lives in `/config/.storage`.
- Weights are safe regardless — `weight_measurement` is in `control_center`, not HA.

## 4. The three migration-defining problems (none were in the original handoff)

### P1 — Architecture flip arm64 → amd64
The mini is Apple Silicon (arm64); the gaming PC is x86-64 (amd64). **Every image CI
builds is arm64-only and will not run on Talos.** This touches the build, not just the
deploy.

**Decision: build multi-arch (`linux/amd64,linux/arm64`) for the transition.** Not
amd64-only, because the mini (arm64) is the rollback target and must keep pulling
runnable images. Mechanism: `platforms: linux/amd64,linux/arm64` on the buildx step.
Native amd64 runner builds amd64 fast and emulates arm64 (or keep both native runners
and merge a manifest). Cost: longer builds during the transition window. After the mini
is retired for good, drop back to amd64-only.
- **Verify, do not assume:** every base image (`oven/bun`, cloudnative-pg, alpine for
  map-provision, plex, go2rtc, HA) publishes an amd64 tag. All are known multi-arch,
  but the plan confirms each digest resolves for amd64 before cutover.

### P2 — Deploy path is welded to OrbStack
The entire CI→cluster path assumes OrbStack: the CA, the `k8s.orb.local` SAN, the
`tailscale serve` host-daemon forward, the `orbstack` kube context. **None exist on
Talos.** Rebuilding it:
- **Tailscale on Talos** exposing the kube API over the tailnet. Talos has no host
  shell, so this is **not** `tailscale up`. Options: (a) the Siderolabs **Tailscale
  system extension** (`tailscaled` as a Talos ExtensionService, host-level, configured
  via `ExtensionServiceConfig` — closest to today's `tailscale serve`), or (b) the
  **Tailscale Kubernetes operator** exposing the API server in-cluster. **Lean (a)**:
  it reproduces today's "host advertises the API over the tailnet" shape and keeps CI's
  mental model. Plan spikes (a) in the VM phase; falls back to (b) if the extension
  can't cleanly forward the API port.
- **New PKI.** Talos generates its own kube API cert/CA. The cert must carry a **SAN
  the CI kubeconfig can validate** (the tailnet DNS name, or keep an explicit
  `tls-server-name` + embedded Talos CA). Configured in the Talos machine config
  (`machine.certSANs` + cluster CA), not patched after.
- **Regenerate `KUBECONFIG__B64`** in the SOPS vault: new CA, new client cert
  (Talos admin talosconfig → kubeconfig), new endpoint. Update `wwwinfra:kubeContext`.
- **`tag:ci` ACL** must still be allowed to reach the new node's API port on the tailnet.

### P3 — HA recorder is SQLite, not Postgres (locked decision needs revisiting)
The brainstorm locked "recorder → CNPG `home_assistant`, separate db same cluster." That
silently assumed a Postgres→Postgres copy. It is actually **SQLite → Postgres**, which is
a schema *conversion*, not a copy: HA would run fresh Alembic migrations on an empty PG
schema and there is **no clean import of existing history** (including the Tesla
long-term statistics we explicitly want to keep). Community SQLite→PG importers exist but
are fragile and unsupported.

**Recommendation (Calum to confirm — flagged, not unilaterally decided):**
**Keep HA on SQLite inside the `/config` PVC for the migration.** The copied
`home-assistant_v2.db` rides along untouched — zero history loss, zero conversion risk,
and it is strictly *simpler* than the locked plan. Moving the recorder to CNPG becomes a
**later, separate, reversible** step (HA supports switching the recorder DB via config;
at that point you either start fresh history or run an importer deliberately). This keeps
the risky HA cutover as small as possible.
- If Calum still wants Postgres now: the plan adds an explicit history-migration spike
  with a go/no-go, and accepts possible loss of pre-migration detailed history (LTS
  may be salvageable separately). Default is SQLite-in-PVC.

## 5. Decisions

### Locked (from brainstorm, still hold)
- Talos bare metal, single node, control plane schedulable.
- HA as a container, not HAOS. `hostNetwork: true` (mDNS/SSDP: Hue/HomeKit/Sonos/Shelly).
- Mini retired cold spare, qcow2 intact, rollback = `start-haos.sh` on the mini.
- 3060 schedulable via Talos NVIDIA extensions + device plugin.
- ESP32 BLE proxy stays (board has no onboard BT/WiFi; radios must be near devices).
- What migrates from HA is `/config` (`.storage` + YAML + `home-assistant_v2.db`),
  tarred out once via the SSH add-on. HAOS qcow2 itself is not migrated.

### Locked defaults (Calum: "defaults is fine")
- **Disk encryption: yes, TPM-sealed** (Z690 fTPM 2.0), STATE + EPHEMERAL partitions.
  No passphrase → unattended reboots work. Recovery path (TPM state change ⇒ rebuild
  node) documented; cheap on a single declarative node with NFS-backed data.
- **CNI: Flannel** (Talos default). Revisit Cilium when node #2 exists.
- **Config: talhelper + SOPS**, checked in under `infra/talos/`.
- **Repo is truth**; drift dies.
- **Static node IP** in the machine config **+ matching UniFi DHCP reservation**.

### Revisited by recon
- **Recorder: SQLite-in-PVC, not CNPG** (P3). ← changes a locked decision, needs a nod.
- **Images: multi-arch** during transition (P1).
- **LoadBalancer:** k3s ServiceLB (klipper) does not exist on Talos. `api` and `plex`
  are `type: LoadBalancer` today. Replace with **MetalLB (L2, single-address pool)** or
  fold to `hostNetwork`/NodePort. **Lean MetalLB** — keeps the Service type unchanged in
  `infra/src/services.ts`, minimal blast radius. Decide in the plan.

### Picked (default unless objected)
- Talos + k8s: latest stable, pinned explicitly in the repo.
- Discovery service: **disabled** (single node, no external dependency).
- `machine.logging`: explicit empty block + comment (only way off a shell-less box when
  observability lands later).
- Image Factory schematic: NVIDIA (kernel modules + container toolkit) **+ `iscsi-tools`
  now** so Longhorn is possible later without a reinstall. Schematic ID pinned in repo.
- inotify sysctls raised (HA + Plex eat watches).
- local-path storage on the ephemeral partition, explicitly declared.
- **Reserve ~4 GB RAM headroom** for the deferred observability stack.

## 6. Data migration plan

| Data | Where | Action |
|---|---|---|
| NFS PVs (api/worker/plex/pg-backup) | Synology | **Re-mount.** Nothing moves. |
| CNPG Postgres (`control_center`) | local-path, mini | **`pg_dump` at cutover** → restore into new CNPG → **row-count + checksum verify vs live mini** before wiping. Mini stays as rollback. |
| HA `/config` | HAOS qcow2, mini | Tar out via SSH add-on once. Includes `.storage` (pairings/tokens) + `home-assistant_v2.db` (SQLite recorder). Land in a new `ha-config` PVC. |
| `plex-config` | local-path, mini | Copy (Plex library/metadata). Non-critical; acceptable to re-scan if it fails. |
| `maps` | local-path, mini | **Do not migrate.** Re-provision via cron / initContainer. |

**No data is destroyed until a restored copy is verified against the still-live mini.**

## 7. Backup parity (container HA loses the Supervisor)

Container HA has **no Supervisor**, so HA's built-in snapshot/backup button disappears.
The migration must not leave the house *less* recoverable than today. Replacement:
- **`ha-config` PVC → scheduled backup to the Synology** (a CronJob, same NFS pattern as
  `pg-backup`), covering `.storage` + SQLite recorder.
- CNPG's existing daily `pg-backup` cron continues to cover `control_center` (and any
  future `home_assistant` PG db).

This is **in scope**, not deferred.

## 8. Cutover order (reversible before irreversible)

0. **File rescue off the PC + wipe** (separate workstream; gates everything — the PC is
   the target hardware). Checksum-verified before the NVMe dies.
1. **Talos up**, house untouched (mini still runs HAOS + k3s).
2. **GPU + storage substrate** verified (NVIDIA device plugin, MetalLB, NFS mounts,
   local-path, CNPG operator).
3. **Stateless workloads** (api, web, worker, go2rtc, plex, cloudflared, cert-manager)
   deployed and healthy against migrated/mounted storage. Deploy path (P2) working so CI
   can reach the node.
4. **Postgres**: dump → restore → verify row counts vs live mini.
5. **HA LAST** — the only point the house goes dark. Hard gate: **old HA (HAOS on mini)
   stopped and verified stopped BEFORE new HA starts.** Both HAs must never talk to
   devices simultaneously (`.storage` pairing corruption for HomeKit/Thread/ESPHome).
   Rollback: stop new HA, `start-haos.sh` on the mini.
6. **Plex** cut over; **mini powered down, cold spare.**

## 9. Validate before touching hardware (Phase 1.5)

Author the full Talos machine config + workload manifests and **validate in a throwaway
local Talos VM** (`talosctl cluster create`, Docker/QEMU) before the PC ever boots Talos:
- **Proves (~80%):** config parses, cluster forms, all stateless workloads apply, CNPG
  restores the dump, HA container starts, MetalLB assigns, the Tailscale-extension /
  kubeconfig story is exercised.
- **Cannot prove (hardware-only, verified once on the real box):** GPU (no 3060 to pass
  through), mDNS/SSDP device discovery (NAT'd VM net), TPM disk encryption (no real TPM).

This collapses the real-hardware work toward a single pass.

## 10. Explicitly deferred

- **Observability** (node/pod metrics + logs). Reserve ~4 GB RAM; keep `machine.logging`
  present-but-empty; storage class stays boring.
- **Longhorn / replicated storage** — decide when node #2 exists. `iscsi-tools` shipped
  now so it needs no reinstall. Today `local-path` means the HA pod can move but its data
  can't.
- **Node #2** — out of scope.
- **Recorder → CNPG Postgres** — deferred by P3 unless Calum wants it now.
- **Cilium** — with node #2.

## 11. What needs Calum (physically or a decision)

Physical (cannot be automated — reflashing the boot USB powers off the live rescue
session; BIOS is at the desk):
1. Confirm rescued files open, or accept the checksum verification.
2. Reflash the USB stick with Talos; **BIOS at the desk**: enable fTPM, USB boot order,
   confirm Secure Boot state.
3. Power off, move to the cupboard, plug Ethernet, power on.
4. Present for the HA cutover to confirm the panel + lights feel right.

Decisions:
- **P3**: SQLite-in-PVC (recommended) vs CNPG-now. Default SQLite-in-PVC.
- **MetalLB vs hostNetwork/NodePort** for the two LoadBalancer services (plan will
  recommend MetalLB).

## 12. Open risks (for the grilling session)

- Tailscale-on-Talos exposing the kube API: does the system extension cleanly forward the
  API port the way `tailscale serve` does today? (VM spike answers this.)
- Talos kube API cert SAN vs the CI kubeconfig's `tls-server-name` contract.
- MetalLB L2 on a single node + `hostNetwork` HA: address-pool and ARP interactions.
- multi-arch build time / cache behavior for the four images.
- Single node = control plane and the house share a box; any Talos upgrade reboots the
  node and the lights pause. Upgrades are manual only (Talos never self-upgrades),
  `talosctl rollback` recovers the prior image until the next upgrade.
- The gaming PC's PSU/thermals under sustained Plex-transcode + cluster load in a cupboard
  (airflow).
