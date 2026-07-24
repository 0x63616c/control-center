# Homelab migration: Mac mini (HAOS + k3s-in-OrbStack) → gaming PC (Talos bare metal)

**Status:** design, pre-plan. Written 2026-07-24. All times LA local.
**Author:** Claude (session 5435128b), from a brainstorm with Calum.
**Scope.** The product code (`features/`, `apps/`, `packages/`) does not change. But
**`infra/` does** — it hardcodes mini/OrbStack-specific values (§4 P4) that must be
edited at cutover. This moves the *cluster it runs on* off the mini onto a Talos node,
and folds Home Assistant into that cluster as a container.

> **Revised 2026-07-24 after adversarial review** (agent pass): added P4 (hardcoded
> infra values), P5 (tailnet-name collision), tightened the `.storage` copy to a
> stopped-HA snapshot at cutover (C1), the multi-arch build to require QEMU/binfmt
> (P1), the Talos API-exposure model to certSANs+`:6443` not a `serve` forward (P2),
> and the TPM story to require the SecureBoot/UKI schematic with BIOS finalized before
> first encrypted boot (§5). All five original factual claims were independently
> re-verified TRUE.

---

## 0. Decisions LOCKED — 2026-07-24 (session 4, with Calum)

These override any contrary text below. Product-owner calls, not grill material.

1. **HA recorder → its OWN CNPG Cluster** (Option B — a separate Postgres instance, NOT
   a second db inside `control-center-1`). DB name `home_assistant`. Rationale: recorder
   is chatty + disposable; `control_center` is the one irreplaceable DB — no shared blast
   radius. Supersedes the P3 "SQLite-in-PVC" recommendation and the "recorder→CNPG same
   cluster" brainstorm lock.
2. **NO recorder history migration.** Calum uses HA only as the integration engine;
   Control Center is the product and never reads the HA recorder (verified: only app
   `recorder` refs are unrelated; Tesla modal explicitly "NO recorder dependency"). Old
   energy/history graphs are disposable. HA starts fresh recording against an empty
   `home_assistant` db. Set an aggressive purge (few days) to keep it tiny.
3. **At cutover, copy ONLY `.storage` (pairings/tokens) + YAML config — NOT
   `home-assistant_v2.db`.** `.storage` is the irreplaceable state (drives device
   pairings; nothing unsyncs as long as it moves clean). The recorder SQLite file is left
   behind. This shrinks the risky HA cutover.
4. **HA workload → its own `home-assistant` namespace** (hyphen; DNS-1123). The
   `home_assistant` CNPG Cluster lives there too. Nothing HA touches `control-center` ns.
5. **Full k8s namespace / multi-tenancy strategy = DEFERRED** to a dedicated design
   session AFTER migration. Migration is lift-and-shift of existing namespaces; only the
   NEW in-cluster HA resources get placed now (#4). Cross-ns DB access is a service-DNS +
   NetworkPolicy detail, so this boxes nothing in; moving a CNPG cluster between ns later
   is a restore op (reversible).

**Still OPEN (Calum to call at BIOS time):** disk encryption — TPM-sealed vs
unencrypted. Physical-theft threat model only; passphrase ruled out (kills headless
reboot). Recommend TPM-sealed if Secure Boot cooperates cleanly, unencrypted fallback.

Naming rule (recurring confusion): k8s resource names use **hyphens** (`control-center`,
`home-assistant` — DNS-1123); Postgres db names use **underscores** (`control_center`,
`home_assistant`).

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
runnable images.
- **The current build action cannot do this as-is.** `.github/actions/build-product-image/
  action.yml` sets up buildx but has **no `docker/setup-qemu-action`** (zero binfmt/QEMU
  anywhere in `.github/`), and the runner is `ubuntu-24.04-arm`. Adding
  `platforms: linux/amd64,linux/arm64` on an arm runner with no binfmt fails to emulate
  amd64. **Concrete mechanism (pick in plan):** (a) switch build jobs to an **amd64
  runner + `setup-qemu-action`** for the arm64 leg, or (b) keep **both native runners**
  (`ubuntu-24.04-arm` + `ubuntu-24.04`) and merge with `docker buildx imagetools create`.
  (b) is faster and avoids OOM-prone emulation of bun builds; (a) is fewer moving parts.
- **Digest-pinning still works:** the deploy step pins the multi-arch **index** digest,
  which is arch-agnostic — no change needed there.
- **Verify, do not assume:** every base image (`oven/bun`, cloudnative-pg, alpine for
  map-provision, plex, go2rtc, HA) publishes an amd64 tag. All are known multi-arch,
  but the plan confirms each digest resolves for amd64 before cutover.

### P2 — Deploy path is welded to OrbStack
The entire CI→cluster path assumes OrbStack: the CA, the `k8s.orb.local` SAN, the
`tailscale serve` host-daemon forward at `:26443`, the `orbstack` kube context. **None
exist on Talos.** The rebuild is *simpler* than today, not just different — the
`tailscale serve`/socat port-forward is an OrbStack artifact (pods can't route the LAN),
and it disappears:
- **Talos kube-apiserver binds `:6443` on all interfaces, including the Tailscale one.**
  There is **no `serve` forward to reproduce** and the endpoint port changes
  `26443 → 6443`. The requirement is just: give the node a tailnet IP + a cert the CI
  kubeconfig validates.
- **Tailscale on Talos** = the Siderolabs **Tailscale system extension** (`tailscaled`
  as a Talos ExtensionService, configured via `ExtensionServiceConfig` with an auth key
  from SOPS). Its only job is to put the node on the tailnet; CI then hits
  `https://<talos-tailnet-name>:6443`. (Not `tailscale up` — Talos has no host shell.)
- **New PKI via certSANs.** Talos generates its own kube API cert/CA. Add the node's
  tailnet FQDN to **`machine.certSANs`** so the cert validates without a
  `tls-server-name` hack. Configured in the machine config, not patched after.
- **Regenerate `KUBECONFIG__B64`** in the SOPS vault: new Talos CA, new admin client
  cert (talosconfig → kubeconfig), new `:6443` endpoint. Update `wwwinfra:kubeContext`.
- **`tag:ci` ACL** must be allowed to reach the new node's `:6443` on the tailnet.
- **Hostname collision (see P5):** the node must NOT take the tailnet name `homelab` —
  the mini keeps it for rollback, and `homelab` is also load-bearing for HA routing.

### P3 — HA recorder is SQLite, not Postgres (locked decision needs revisiting)
The brainstorm locked "recorder → CNPG `home_assistant`, separate db same cluster." That
silently assumed a Postgres→Postgres copy. It is actually **SQLite → Postgres**, which is
a schema *conversion*, not a copy: HA would run fresh Alembic migrations on an empty PG
schema and there is **no clean import of existing history** (including the Tesla
long-term statistics we explicitly want to keep). Community SQLite→PG importers exist but
are fragile and unsupported.

**DECIDED 2026-07-24 (§0.1–3), superseding the SQLite recommendation this section
originally made:** the lossy-conversion problem this section raised is what made history
*disposable* the right answer — Calum confirmed the app never reads the recorder and he
doesn't care about HA's own history graphs. So: **HA recorder → a fresh empty
`home_assistant` db in its OWN CNPG Cluster** (not a second db in `control-center-1`),
with **no history migrated** and only `.storage`+YAML copied at cutover. The SQLite
`home-assistant_v2.db` is left behind entirely. This is *simpler* than both the original
locked plan (no conversion) and the SQLite-in-PVC fallback (no second datastore type),
and gives Calum the single-Postgres end state he wanted while keeping HA's disposable
churn off the one irreplaceable DB.

### P4 — `infra/src/services.ts` hardcodes mini/OrbStack values (the app "not changing" is false for infra)
Three values are pinned to the mini and will silently break HA-backed tiles and Plex
after cutover — they are **not** "regenerable" and **not** "unchanged":
- **`HA_TAILNET_FQDN = "homelab.tail8c014d.ts.net"`** (services.ts:101) — the `ha`
  ExternalName Service CNAMEs to it (line 566); api/worker reach HA via `http://ha:8123`
  → `HA_URL` (line 140). This FQDN routes to the **mini's** HA socat. Retire the mini and
  every HA tile (climate, controls, weight-ingest) dies. On a hostNetwork HA on the Talos
  node, the `ha` ExternalName must point at the node/localhost, not a tailnet name.
- **Plex `ADVERTISE_IP: "http://192.168.0.147:32400"`** (services.ts:355) — the **Mac's**
  LAN IP. After migration the Apple TV gets an unreachable advertise URL. Must become the
  Talos node's LAN IP (or the Plex MetalLB IP).
- The whole `ha`-via-tailnet-FQDN indirection exists **only** because OrbStack pods can't
  route `192.168.0.0/24` (services.ts:97). On a real-LAN Talos node this hack should be
  **deleted**, not ported. (Same for the UniFi `:8444` and LAN-443 socat forwards — they
  simply vanish; a genuine simplification.)

**These are explicit plan edits, gated behind the VM validation.**

### P5 — the tailnet name `homelab` is shared by the kube API AND HA, and collides with rollback
`homelab.tail8c014d.ts.net` serves the kube API (`:26443`) **and** the HA socat (`:8123`)
— it is the **mini**. Two independent consumers, one name. Rollback (§8 step 5 =
`start-haos.sh` on the mini) requires the **mini to keep owning `homelab`**. Therefore:
- The Talos node joins the tailnet under a **distinct** machine name (e.g. `talos-prod`).
- Update: the CI kubeconfig endpoint, `machine.certSANs`, the `ha` ExternalName (P4), and
  the `tag:ci` ACL to the new name.
- **Rollback is defined:** repoint CI + the `ha` ExternalName back to `homelab` (mini),
  Talos stays off that name. Never let both machines claim `homelab`.

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
  No passphrase → unattended reboots work. **Prerequisites (H4, do not skip):**
  - Talos TPM sealing is coupled to **Secure Boot + UKI** — the Image Factory schematic
    must be the **SecureBoot variant** (not the plain NVIDIA+iscsi schematic). Without
    it, encryption falls back to a **passphrase**, which breaks unattended reboots — the
    whole reliability goal. Plan confirms the exact requirement for the pinned Talos
    version before committing.
  - **All BIOS security settings (fTPM, Secure Boot) must be finalized BEFORE the first
    encrypted boot.** TPM sealing binds to PCR measurements; any Secure Boot / PCR change
    *after* first boot re-seals to different values → node won't unseal → rebuild. This is
    a hard step-order gate in §11 (BIOS is set once, at the desk, before install).
  - Recovery path (TPM/PCR change ⇒ rebuild node) documented; cheap on a single
    declarative node with NFS-backed data.
  - **Fallback if SecureBoot proves fiddly on this board:** ship **unencrypted** and
    revisit, rather than a passphrase that defeats headless reboots. Encryption is a
    nice-to-have here (physical-theft only); unattended reboot is load-bearing.
- **CNI: Flannel** (Talos default). Revisit Cilium when node #2 exists.
- **Config: talhelper + SOPS**, checked in under `infra/talos/`.
- **Repo is truth**; drift dies.
- **Static node IP** in the machine config **+ matching UniFi DHCP reservation**.

### Revisited by recon
- **Recorder → own CNPG Cluster `home_assistant`, no history migration** (§0.1–3, decided). Supersedes the SQLite-in-PVC recommendation in P3 below.
- **Images: multi-arch** during transition (P1).
- **LoadBalancer:** k3s ServiceLB (klipper) does not exist on Talos. `api` and `plex`
  are `type: LoadBalancer` today (EXTERNAL-IP `192.168.139.2`, an OrbStack subnet).
  Replace with **MetalLB (L2, single-address pool on the real LAN)** or fold to
  `hostNetwork`/NodePort. **Lean MetalLB** — keeps the Service type unchanged in
  `infra/src/services.ts`, minimal blast radius. **M7 — the new LB IPs ripple** and the
  plan must inventory the fan-out: the UniFi DHCP reservation (reserve the MetalLB
  pool too, not just the node IP), the cert-manager cert for `api`'s 443, cloudflared's
  origin targets, and Plex `ADVERTISE_IP` (P4). Also watch MetalLB-L2 ARP vs the
  hostNetwork HA pod on a single node (§12).

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
| HA `/config` | HAOS qcow2, mini | **Two copies.** (1) An early **throwaway rehearsal tar** (HA running) to build+test the container in the VM phase. (2) The **authoritative copy at cutover with HA STOPPED** (C1). Copy `.storage` (pairings/tokens) + YAML **only** — NOT `home-assistant_v2.db` (recorder left behind, §0.3). Land in a new `ha-config` PVC. |
| HA recorder | — | **Not migrated (§0.2).** New `home_assistant` db in its own CNPG Cluster (`home-assistant` ns); HA records fresh from cutover, aggressive purge. |
| `plex-config` | local-path, mini | Copy (Plex library/metadata). Non-critical; acceptable to re-scan if it fails. |
| `maps` | local-path, mini | **Do not migrate.** Re-provision via cron / initContainer. |

**No data is destroyed until a restored copy is verified against the still-live mini.**

## 7. Backup parity (container HA loses the Supervisor)

Container HA has **no Supervisor**, so HA's built-in snapshot/backup button disappears.
The migration must not leave the house *less* recoverable than today. Replacement:
- **`ha-config` PVC → scheduled backup to the Synology** (a CronJob, same NFS pattern as
  `pg-backup`), covering `.storage` + YAML (the irreplaceable state; §0.3).
- CNPG's existing daily `pg-backup` cron covers `control_center`; the new
  `home_assistant` CNPG Cluster (§0.1) gets its own backup entry (its data is disposable,
  but keep the pattern uniform).

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
5. **HA LAST** — the only point the house goes dark. Sequence inside the gate:
   1. **Stop HAOS on the mini** (`ha core stop`, or stop the recorder at minimum) and
      **verify stopped**.
   2. **Only now** take the authoritative `/config` copy (C1) — a stopped-HA snapshot of
      `.storage` + YAML **only** (recorder db NOT copied, §0.3). A live tar risks
      half-written `.storage` (HomeKit/Thread pairings) — the one
      truly irreplaceable data in the whole migration.
   3. Load it into the `ha-config` PVC; **start the new HA container.**
   Both HAs must never talk to devices simultaneously (`.storage` pairing corruption for
   HomeKit/Thread/ESPHome). Rollback: stop new HA, `start-haos.sh` on the mini, repoint
   the `ha` ExternalName + CI back to `homelab` (P5).
   - **Cutover verification (M8):** confirm the `renpho_fitness_scale_ble` custom
     integration (and any HACS `custom_components`) reinstalls its pip deps into
     `/config/deps` on container-HA boot — official container HA ships no HACS. Verify the
     weight sensor entity resolves post-cutover.
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
- **Full k8s namespace / multi-tenancy strategy** — deferred to a post-migration design
  session (§0.5). Migration only places the new in-cluster HA resources (§0.4).
- ~~Recorder → CNPG Postgres~~ — **DECIDED** (§0.1): own CNPG Cluster, no history migration.
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
- ~~P3 recorder~~ — **DECIDED §0**: own CNPG Cluster `home_assistant`, no history migration.
- **Disk encryption** — TPM-sealed vs unencrypted. STILL OPEN; call at BIOS time (§0).
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
