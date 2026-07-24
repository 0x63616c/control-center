# Homelab Migration Implementation Plan (mini → Talos on the gaming PC)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move prod off the Mac mini (HAOS-in-qcow2 + k3s-in-OrbStack) onto Talos Linux
bare metal on the gaming PC, fold Home Assistant in as a container, expose the RTX 3060
as a schedulable GPU, and keep CI `push-to-main` deploying — with the mini intact as a
one-command rollback.

**Architecture:** Single-node Talos cluster, control plane schedulable. Product workloads
re-declared via the existing Pulumi program (`infra/`) with mini-specific values edited
out. HA runs `hostNetwork: true` with `/config` on a PVC (SQLite recorder rides along).
CI reaches the node's kube-apiserver at `:6443` over Tailscale (system extension), with
new PKI. Everything reversible happens before anything irreversible; HA cuts over last.

**Tech Stack:** Talos Linux, talhelper + SOPS, Pulumi + `@pulumi/kubernetes`, CloudNativePG,
MetalLB, Tailscale (Talos system extension + `tag:ci` OAuth), Docker buildx multi-arch,
GitHub Actions, cloudflared, cert-manager.

**Source spec:** `docs/superpowers/specs/2026-07-24-homelab-migration-design.md` (read it;
this plan implements it). All recon facts and findings (C1, P1–P5, H4, M6–M8) are there.

## Global Constraints

- **Reversible before irreversible.** No mini state is destroyed until a restored copy is
  verified against the still-live mini. Mini is never wiped; HAOS qcow2 stays as rollback.
- **Both HAs must NEVER talk to devices simultaneously** (`.storage` pairing corruption).
- **Talos has no WiFi and no host shell.** Wired 2.5 GbE only. Everything is machine-config
  or a manifest — no `ssh`/`tailscale up`/manual `kubectl apply` of undeclared state.
- **Repo is truth.** New substrate lives in `infra/talos/` (talhelper) + `infra/src/`. No
  hand-applied drift. Secrets stay in the SOPS vault (`secrets/vault.yaml`); never printed.
- **Arch:** node is amd64; images must be multi-arch (`linux/amd64,linux/arm64`) until the
  mini is retired for good.
- **Tailnet name:** the Talos node is `talos-prod`, NOT `homelab` (the mini keeps that).
- **Pulumi digest namespace is `wwwinfra:`** (not `ccinfra:`).
- **Commit + push to `main` often** (AGENTS.md). Push deploys — but the deploy targets the
  mini until Task 9 repoints CI, so early infra commits are safe (they converge the mini).
- **kubectl against the mini is READ-ONLY** during migration except the explicit cutover
  steps. Context `cc-homelab` = mini; a new context = Talos.
- **All times LA local.**

---

## Phase 0 — File rescue + wipe (BLOCKING, separate workstream)

Tracked in the session task list, not re-specified here. Gates everything: the PC is the
target hardware. Done when OBS+P are checksum-verified onto the EasyStore and Stage-1 data
is confirmed on the NAS. Only then is the NVMe wiped and Talos flashed. **Nothing in Phase
1+ starts until the PC is free.**

Resilient resume (survives the oomd kills that already killed one OBS run):
```bash
sudo nohup sh -c '
  until rsync -a --no-links --no-perms --no-owner --no-group \
    "/mnt/win/Users/Calum/Desktop/OBS/" "/mnt/ext3/Gaming PC Backup 2026/Desktop/OBS/"; do
    echo "OBS retry $(date)"; sleep 5; done
  until rsync -a --no-links --no-perms --no-owner --no-group \
    "/mnt/win/Users/Calum/Desktop/P/" "/mnt/ext3/Gaming PC Backup 2026/Desktop/P/"; do
    echo "P retry $(date)"; sleep 5; done
  sync; echo ALL_DONE
' > /tmp/video2.log 2>&1 &
```
Verify: per-file `cmp`/checksum sample of large files; `sync`; open a PDF/photo/video from
the Mac. rsync exiting is NOT proof (the first run printed nothing useful and died mid-file).

---

## Phase 1 — Repo prep (no hardware; do while Phase 0 copies)

These tasks touch only the repo and are safe to land on `main` early because CI still
deploys to the mini and `pulumi up` converges the *mini* — none of these change the mini's
running state until they're wired into the Talos provider (Task 8+). Each is independently
reviewable.

### Task 1: Multi-arch build (P1 + H5)

**Files:**
- Modify: `.github/actions/build-product-image/action.yml`
- Modify: `.github/workflows/ci.yml:256-338` (the four `build-*` jobs' `runs-on`)
- Test: `scripts/test-build-matrix.sh` (new, hermetic assertion on the workflow YAML)

**Interfaces:**
- Produces: multi-arch image indexes at `ghcr.io/0x63616c/www-control-center-*:main`. The
  deploy job's `docker buildx imagetools inspect ... --format '{{.Manifest.Digest}}'`
  already reads the **index** digest (arch-agnostic) — no deploy change needed.

- [ ] **Step 1: Write the failing guard test**
```bash
# scripts/test-build-matrix.sh
set -euo pipefail
f=.github/actions/build-product-image/action.yml
grep -q 'setup-qemu-action' "$f" || { echo "FAIL: no QEMU setup for cross-arch"; exit 1; }
grep -q 'linux/amd64' "$f" || { echo "FAIL: amd64 not in platforms"; exit 1; }
grep -q 'linux/arm64' "$f" || { echo "FAIL: arm64 dropped (mini rollback needs it)"; exit 1; }
echo "PASS"
```
- [ ] **Step 2: Run it, expect FAIL** — `bash scripts/test-build-matrix.sh` → "no QEMU setup".
- [ ] **Step 3: Implement.** In `action.yml`, before `setup-buildx-action`, add:
```yaml
    - name: Set up QEMU (cross-arch emulation)
      uses: docker/setup-qemu-action@v3
```
  Change the `platforms` default from `linux/arm64` to `linux/amd64,linux/arm64`. In
  `ci.yml`, switch the four `build-*` jobs from `runs-on: ubuntu-24.04-arm` to
  `runs-on: ubuntu-24.04` (amd64 native; arm64 leg emulates via QEMU). Retitle the action
  from "Build and push ARM64 image" to "Build and push multi-arch image".
  - **Alternative (faster, if QEMU emulation OOMs the bun build):** keep both native
    runners in a matrix and merge with `docker buildx imagetools create -t ...:main
    <amd64-digest> <arm64-digest>`. Decide by watching the first build's time/memory.
- [ ] **Step 4: Run guard, expect PASS.** `bash scripts/test-build-matrix.sh`.
- [ ] **Step 5: Add the guard to CI** — one line in `ci.yml` `test-unit` alongside the other
  `bash scripts/test-*.sh` guards.
- [ ] **Step 6: Commit + push.** Watch the run: `gh run watch --exit-status`. Confirm each
  image is now an index with both arches:
  `docker buildx imagetools inspect ghcr.io/0x63616c/www-control-center-api:main` shows
  `linux/amd64` + `linux/arm64`. **This is the amd64-availability proof for every app image.**

### Task 2: Talos machine config via talhelper (`infra/talos/`)

**Files:**
- Create: `infra/talos/talconfig.yaml` (talhelper input)
- Create: `infra/talos/talsecret.sops.yaml` (SOPS-encrypted Talos secrets)
- Create: `infra/talos/README.md` (how to regenerate + apply)
- Create: `infra/talos/.gitignore` (ignore rendered `clusterconfig/` if not committing it)
- Test: `scripts/test-talos-config.sh` (hermetic: `talhelper genconfig` + `talosctl validate`)

**Interfaces:**
- Produces: a validated Talos machine config for node `talos-prod`, single control plane,
  schedulable, Flannel, disk encryption (SecureBoot/TPM per §5/H4), NVIDIA + iscsi-tools +
  Tailscale extensions, `machine.certSANs` incl. the tailnet FQDN, `machine.logging` empty
  block, inotify sysctls, discovery disabled, static IP.

- [ ] **Step 1: Pin the Image Factory schematic.** Create the schematic with **SecureBoot**
  + `siderolabs/nvidia-container-toolkit` + `siderolabs/nonfree-kmod-nvidia` +
  `siderolabs/iscsi-tools` + `siderolabs/tailscale`. Record the returned schematic ID in
  `README.md`. **Verify** the SecureBoot variant supports `tpm` disk-encryption key type for
  the pinned Talos version before locking it (H4); if not, fall back to unencrypted (NOT a
  passphrase — §5).
- [ ] **Step 2: Write `talconfig.yaml`.** Real values:
```yaml
clusterName: prod
endpoint: https://talos-prod.tail8c014d.ts.net:6443   # tailnet name, NOT homelab (P5)
nodes:
  - hostname: talos-prod
    controlPlane: true
    installDisk: /dev/nvme0n1
    installDiskSelector: {}
    schematic:
      id: <SCHEMATIC_ID_FROM_STEP_1>
    networkInterfaces:
      - interface: <2.5GbE-iface>          # confirm on first boot (predictable name)
        addresses: [192.168.0.NNN/24]      # static; matches a UniFi reservation
        routes: [{ network: 0.0.0.0/0, gateway: 192.168.0.1 }]
    machineDisks: []
patches:
  - |-
    machine:
      certSANs: [talos-prod.tail8c014d.ts.net, 192.168.0.NNN]   # CI kubeconfig validates this
      features: { hostDNS: { enabled: true, forwardKubeDNSToHost: true } }
      sysctls:
        fs.inotify.max_user_watches: "1048576"
        fs.inotify.max_user_instances: "8192"
      logging: {}         # explicit empty: the ONLY way off a shell-less box later (§10)
    cluster:
      discovery: { enabled: false }        # single node, no external dep
      allowSchedulingOnControlPlanes: true
    # Disk encryption (H4) — SecureBoot/TPM; drop this block if the board fights SecureBoot:
    machine:
      systemDiskEncryption:
        state:     { provider: luks2, keys: [{ tpm: {}, slot: 0 }] }
        ephemeral: { provider: luks2, keys: [{ tpm: {}, slot: 0 }] }
```
- [ ] **Step 3: Generate Talos secrets** into `talsecret.sops.yaml`
  (`talhelper gensecret > ...` then `sops -e -i ...` with the repo age recipient). Never
  commit plaintext.
- [ ] **Step 4: Write the validate guard** — `scripts/test-talos-config.sh`:
  `talhelper genconfig` to a temp dir, then `talosctl validate --mode metal -c <rendered>`.
- [ ] **Step 5: Run it, expect PASS** (config valid, even with no hardware).
- [ ] **Step 6: Commit + push** (repo-only; does not touch the mini).

### Task 3: Retire mini-specific infra values behind a target flag (P4)

**Files:**
- Modify: `infra/src/services.ts:96-101,135-140,341-355,561-571`
- Modify: `infra/src/cluster.ts` (add a `substrate: "orbstack" | "talos"` config input)
- Test: `infra/src/services.test.ts` (or the existing infra test file)

**Interfaces:**
- Produces: `haExternalName(substrate)` and `plexAdvertiseIp(substrate)` helpers so the
  mini values (`homelab.tail8c014d.ts.net`, `192.168.0.147`) are used ONLY when
  `substrate === "orbstack"`, and the Talos values (node localhost / node LAN IP) when
  `"talos"`. Default stays `orbstack` so nothing changes until Task 8 flips it.

- [ ] **Step 1: Write failing test.**
```ts
test("ha ExternalName targets node localhost on talos", () => {
  expect(haExternalName("talos")).toBe("127.0.0.1");        // hostNetwork HA on the node
  expect(haExternalName("orbstack")).toBe("homelab.tail8c014d.ts.net");
});
test("plex advertise uses node LAN IP on talos", () => {
  expect(plexAdvertiseIp("talos", "192.168.0.NNN")).toBe("http://192.168.0.NNN:32400");
});
```
- [ ] **Step 2: Run, expect FAIL** (helpers undefined).
- [ ] **Step 3: Implement** the two helpers; thread `substrate` from a
  `wwwinfra:substrate` Pulumi config (default `"orbstack"`). Replace the hardcoded literals
  at the cited lines with the helpers. Delete the now-dead comment about OrbStack LAN
  routing only under the `talos` branch (keep both branches until the mini is retired).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Typecheck** — `bun run typecheck`.
- [ ] **Step 6: Commit + push.** With `substrate` defaulting to `orbstack`, the mini deploy
  is byte-identical — verify the next `pulumi up` shows **no diff** for `ha`/`plex`.

### Task 4: MetalLB + backup-cron + HA manifests as Pulumi resources (behind the flag)

**Files:**
- Create: `infra/src/metallb.ts` (operator + `IPAddressPool` + `L2Advertisement`)
- Create: `infra/src/homeassistant.ts` (HA Deployment `hostNetwork:true`, `ha-config` PVC,
  Service, the stopped-copy note)
- Modify: `infra/src/crons.ts` (add `ha-config` backup CronJob → Synology NFS, §7)
- Modify: `infra/src/cluster.ts` / `index.ts` (wire the above only when `substrate==="talos"`)
- Test: extend `scripts/test-cc-cutover-preflight.sh` or a new `scripts/test-talos-substrate.sh`

**Interfaces:**
- Consumes: `substrate` flag (Task 3), NFS server IP (already threaded, `crons.ts:167`).
- Produces: `installMetalLB`, `deployHomeAssistant`, `haConfigBackupCronSpec` — all no-ops
  when `substrate==="orbstack"` so committing them does nothing to the mini.

- [ ] **Step 1: MetalLB.** `infra/src/metallb.ts`: install the operator manifest (pinned
  version), an `IPAddressPool` with a single reserved LAN address range (documented in the
  UniFi reservation), an `L2Advertisement`. `api` and `plex` keep `type: LoadBalancer`.
- [ ] **Step 2: HA manifest.** `infra/src/homeassistant.ts`: `Deployment`
  `ghcr.io/home-assistant/home-assistant:stable` (multi-arch upstream), `hostNetwork: true`,
  `dnsPolicy: ClusterFirstWithHostNet`, `/config` ← `ha-config` PVC (`local-path`, e.g.
  5Gi), resources with headroom. NO Supervisor. Add a `# STORAGE.md` note that the PVC is
  seeded from the **stopped-HA snapshot** at cutover (C1), not here.
- [ ] **Step 3: `ha-config` backup cron.** In `crons.ts`, add a CronJob mirroring
  `postgresBackupCronSpec`'s NFS pattern: `tar czf` (or `sqlite3 .backup` for the recorder)
  `/config` → Synology NFS on a schedule. This replaces the Supervisor snapshot the
  container loses (§7). Cover the failure path (`set -eo pipefail`).
- [ ] **Step 4: Guard test** asserts all three are absent from the rendered stack when
  `substrate==="orbstack"` and present when `"talos"`.
- [ ] **Step 5: Typecheck + test + commit + push.** Mini unaffected (flag defaults orbstack).

### Task 5: Postgres restore-proof rehearsal (uses the safety dump; no hardware)

**Files:**
- Use: `scripts/pg-snapshot-restore.sh` (existing), the safety dump
  `scratchpad/cc-control_center-20260724.dump`, the baseline `cc-rowcounts-20260724.tsv`.
- Create: `docs/superpowers/plans/cutover-runbook.md` (the exact cutover command sequence)

**Interfaces:**
- Produces: proof that `control_center` restores clean into a fresh CNPG cluster with
  matching per-table row counts — the exact procedure Task 10 runs against real hardware.

- [ ] **Step 1:** In the local Talos VM (Task 6) or a scratch CNPG namespace, restore the
  safety dump and diff row counts vs `cc-rowcounts-20260724.tsv` using the script's
  `--compare-counts`. Expected: zero mismatches across all 24 tables.
- [ ] **Step 2:** Write the cutover runbook: fresh `pg_dump` at cutover → restore →
  `--compare-counts` vs a same-moment live count → go/no-go. Commit.

---

## Phase 1.5 — Validate the whole config in a throwaway Talos VM (§9)

### Task 6: Local Talos VM dress-rehearsal

**Files:** none new (uses `infra/talos/` + `infra/src/` from Phase 1).

**Interfaces:**
- Produces: green/red on ~80% of the design before any hardware — config parses, cluster
  forms, MetalLB assigns, all stateless workloads apply, CNPG restores, HA container starts.

- [ ] **Step 1:** `talosctl cluster create --name talos-vm ...` (Docker or QEMU provisioner).
- [ ] **Step 2:** Point a `talos-vm` Pulumi stack (or `kubectl apply` of the rendered
  manifests) with `substrate:talos` at the VM. Bring up MetalLB, CNPG, api/web/worker/
  go2rtc/plex/cloudflared/cert-manager, HA.
- [ ] **Step 3:** Restore the safety dump (Task 5) into the VM's CNPG; verify row counts.
- [ ] **Step 4:** Exercise the Tailscale-extension + `:6443` + certSAN path far enough to
  confirm a kubeconfig built from Talos PKI reaches the API (M6).
- [ ] **Step 5:** Record what passed and the **hardware-only gaps** (GPU, mDNS discovery,
  TPM) in the cutover runbook. `talosctl cluster destroy`.
- [ ] **Step 6:** Commit any config fixes the VM surfaced.

---

## Phase 2 — Hardware bring-up (needs Calum physically; house untouched)

### Task 7: Flash, BIOS, boot Talos

**Interfaces:** Produces a running single-node Talos cluster on the PC, on the LAN, on the
tailnet as `talos-prod`. Mini still runs HAOS + k3s — house fully live.

- [ ] **Step 1 (Calum, at the desk):** reflash the boot USB with the SecureBoot Talos image
  (schematic from Task 2). **Finalize BIOS BEFORE first encrypted boot (H4):** enable fTPM,
  enable Secure Boot, set USB→NVMe boot order. Do it once, at the desk, monitor attached.
- [ ] **Step 2:** `talhelper` → `talosctl apply-config --insecure` to the node; `talosctl
  bootstrap`; `talosctl kubeconfig`. Confirm `kubectl --context talos-prod get nodes` Ready.
- [ ] **Step 3:** Confirm the Tailscale extension put the node on the tailnet as
  `talos-prod`; `kubectl` over `:6443` via the tailnet works. Confirm disk encryption is
  active (`talosctl get systemdiskencryption`) OR consciously unencrypted (H4 fallback).
- [ ] **Step 4:** Move to cupboard? — NO. Keep at the desk until HA cutover verified (spec
  §11). Ethernet already reaches the desk.
- **Rollback:** none needed — nothing on the mini touched. Powering the PC off is free.

### Task 8: GPU + storage substrate

- [ ] **Step 1:** Deploy the NVIDIA device plugin; `kubectl describe node` shows
  `nvidia.com/gpu`. Run a `nvidia-smi` test pod — sees the 3060.
- [ ] **Step 2:** MetalLB up; `IPAddressPool` reachable (ARP) on the LAN.
- [ ] **Step 3:** Mount the four Synology NFS PVs read-only-probe from a throwaway pod —
  confirm reachable from the Talos node netns (they worked from the mini; confirm from here).
- [ ] **Step 4:** CNPG operator installed; local-path provisioner working.
- **Rollback:** delete the Talos workloads; mini unaffected.

---

## Phase 3 — Stateless workloads + deploy path (house still on the mini)

### Task 9: Repoint CI to Talos, deploy the stateless stack

**Files:** Modify `secrets/vault.yaml` (`KUBECONFIG__B64`), `wwwinfra:kubeContext` /
`wwwinfra:substrate` Pulumi config, Tailscale ACL (`tag:ci` → reach `talos-prod:6443`).

- [ ] **Step 1:** Build the new CI kubeconfig from Talos admin PKI, endpoint
  `https://talos-prod.tail8c014d.ts.net:6443`, embed the Talos CA. `base64` → replace
  `KUBECONFIG__B64` in the SOPS vault. Update the `tag:ci` ACL grant to the new node:port.
- [ ] **Step 2:** Set `wwwinfra:substrate=talos` and `wwwinfra:kubeContext=<talos ctx>` on
  the prod stack. This flips Task 3/4 branches: MetalLB, HA manifest, backup cron, and the
  Talos `ha`/`plex` values become live.
- [ ] **Step 3:** `pulumi up` (via CI or locally) targeting **Talos**. Deploy api, web,
  worker, go2rtc, plex, cloudflared, cert-manager — everything EXCEPT relying on HA yet.
  Storage: NFS PVs mounted; local-path for plex-config/maps (maps re-provisions).
- [ ] **Step 4:** Verify each workload healthy on Talos; `api /up` green; web loads; go2rtc
  streams; cloudflared tunnel up; cert-manager issued `api`'s cert against the new MetalLB IP
  (M7). **HA tiles will error** (HA still on the mini, and `ha` ExternalName now points at
  the Talos node which has no HA yet) — expected, next phase.
- **Rollback:** set `substrate=orbstack`, restore the mini `KUBECONFIG__B64`, `pulumi up` →
  CI + workloads converge the mini again. House never depended on Talos in this phase.

### Task 10: Postgres cutover

- [ ] **Step 1:** Fresh `pg_dump` of `control_center` from the mini (read-only). Capture a
  same-moment row-count.
- [ ] **Step 2:** Restore into the Talos CNPG `control_center`. `--compare-counts` vs the
  same-moment count — zero mismatches (runbook from Task 5). App on Talos now points at the
  Talos DB.
- [ ] **Step 3:** Verify weight/weather/frontend_log tiles read correctly on Talos.
- **Rollback:** point the app back at the mini DB (still live, untouched).

---

## Phase 4 — HA cutover (house goes dark briefly) + finish

### Task 11: HA cutover (C1 gate)

- [ ] **Step 1:** Announce house-dark window. **Stop HAOS on the mini** (`ha core stop`);
  **verify stopped** (`:8123` refuses).
- [ ] **Step 2 (C1):** ONLY NOW take the authoritative `/config` — stopped-HA snapshot /
  `sqlite3 home-assistant_v2.db ".backup"`. Copy `.storage` + YAML + recorder DB into the
  `ha-config` PVC.
- [ ] **Step 3:** Start the Talos HA container (`hostNetwork`). It reinstalls custom-integration
  pip deps into `/config/deps` on boot.
- [ ] **Step 4 (M8 verify):** confirm Hue/Shelly/HomeKit/Apple TV/Sonos/Tesla/ESPHome/Thread
  reconnect; **`renpho_fitness_scale_ble` entity resolves**; go2rtc cameras work; the wall
  panel is live and the lights respond. **Calum confirms the panel feels right.**
- [ ] **Step 5:** Confirm the `ha-config` backup cron runs once successfully to the Synology.
- **Rollback:** stop the Talos HA, `start-haos.sh` on the mini, set `substrate=orbstack`,
  restore mini `KUBECONFIG__B64`, `pulumi up`, repoint `ha` ExternalName + CI to `homelab`.

### Task 12: Plex + cold-spare the mini

- [ ] **Step 1:** Cut Plex fully to Talos (`ADVERTISE_IP` = Talos LAN IP, GPU transcode via
  the device plugin / `nvidia` runtimeClass; Plex Pass required for NVENC). Verify Apple TV
  playback + a hardware transcode.
- [ ] **Step 2:** Move the PC to the cupboard (one power-off/on; static IP + reservation mean
  it comes back identically).
- [ ] **Step 3:** Power down the mini. **Do not wipe.** Label it cold spare; HAOS qcow2 +
  `start-haos.sh` intact. Record the rollback procedure in the runbook.
- [ ] **Step 4:** Update docs: `CODEBASE_OVERVIEW.md` (deploy path, arch, substrate),
  `AGENTS.md` Infra section, `docs/homelab-host.md`. Fix the stale `ccinfra:`→`wwwinfra:`.
- [ ] **Step 5:** After a stable soak, drop the arm64 build leg back to amd64-only (reverse
  Task 1) — optional, only once rollback is truly abandoned.

---

## Self-Review (against the spec)

**Spec coverage:** §2 end-state → Tasks 2,7,8,9,11,12. §4 P1→T1, P2→T2/T9, P3(SQLite)→T4/T11,
P4→T3, P5→T2/T9. §5 defaults (TPM/H4→T2/T7, Flannel→T2, talhelper→T2, static IP→T2, MetalLB
+M7→T4/T9). §6 data table → T5/T10 (PG), T11 (HA /config), maps/plex-config → T9. §7 backup
parity → T4/T11. §8 cutover order → Phases 0–4 in order. §9 VM → T6. §10 deferred → not
tasked (correct). §11 physical → T7/T11. §12 risks → each has a rollback line.

**Placeholder scan:** remaining `<...>` tokens are values only discoverable ON hardware
(schematic ID, 2.5GbE iface name, chosen static IP/MetalLB pool) — each flagged with how to
obtain it, not hand-waved logic. Acceptable.

**Type consistency:** `substrate` flag, `haExternalName`/`plexAdvertiseIp` helpers, and
`wwwinfra:` namespace used consistently across T3/T4/T9.

**Open decisions still Calum's:** SQLite-in-PVC vs CNPG-now (default SQLite, T4/T11);
encryption-vs-unencrypted if SecureBoot fights the board (T2/T7); multi-arch mechanism (a)
vs (b) (T1, decide on first build).
