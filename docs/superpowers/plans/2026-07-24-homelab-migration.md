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
out behind a `substrate` flag. HA runs `hostNetwork: true` with `/config` on a PVC (SQLite
recorder rides along). CI reaches the node's kube-apiserver at `:6443` over Tailscale
(system extension), with new PKI. Everything reversible happens before anything
irreversible; HA cuts over last.

**Tech Stack:** Talos Linux, talhelper + SOPS, Pulumi + `@pulumi/kubernetes`, CloudNativePG,
MetalLB, rancher local-path-provisioner, Tailscale (Talos system extension + `tag:ci`
OAuth), Docker buildx multi-arch, GitHub Actions, cloudflared, cert-manager.

**Source spec:** `docs/superpowers/specs/2026-07-24-homelab-migration-design.md`.

> **Revised 2026-07-24 after a second adversarial (plan) review.** Folded: C1 `ha`
> ExternalName must be the node LAN IP not loopback; **C2 disable the `ha-watchdog`
> before the cutover stop (the one house-bricking hole)**; H1 cloudflared split-brain
> (use the existing `cloudflaredReplicas=0` knob); H2 install local-path-provisioner
> (Talos has none); H3 first apply at empty `imageDigests` (GHCR preflight throws on a
> fresh cluster); H4 two-context kubeconfig + `kubeContext` toggle instead of swapping the
> shared vault secret; H5 ADD the tailnet ACL not replace; H6 native two-runner
> manifest-merge, proven on a branch; M1–M8/L1–L3. **M5 (metrics-server TLS) was a false
> positive — `--kubelet-insecure-tls` already present (metrics-server.ts:47).** The infra
> entrypoint is `infra/src/index.ts` (not `program.ts`).

## Global Constraints

- **Reversible before irreversible.** No mini state is destroyed until a restored copy is
  verified against the still-live mini. Mini is never wiped; HAOS qcow2 stays as rollback.
- **Both HAs must NEVER talk to devices simultaneously** (`.storage` pairing corruption).
  This includes the mini's **`ha-watchdog`** silently restarting HA — it MUST be disabled
  before the cutover stop (C2).
- **Talos has no WiFi and no host shell.** Wired 2.5 GbE only. Everything is machine-config
  or a manifest.
- **Repo is truth.** New substrate lives in `infra/talos/` (talhelper) + `infra/src/`.
- **Deploy targeting is a committed one-liner, not a secret swap.** `KUBECONFIG__B64`
  carries **both** contexts (mini + Talos); the live target is chosen by the plaintext
  `wwwinfra:kubeContext` in `Pulumi.prod.yaml`. Rollback = revert one line. (H4)
- **Main-push quiet window** announced across sessions for the Task 9–11 cutover span
  (8–10 sessions push `main`, mostly direct — MEMORY `parallel-claude-sessions-push-main`).
- **Arch:** node is amd64; images multi-arch (`linux/amd64,linux/arm64`) until the mini is
  retired. The **arm64 leg stays native** (don't degrade the mini's live deploy). (H6)
- **Tailnet name:** the node is `talos-prod`, NOT `homelab` (the mini keeps that). ACL
  grants are ADDED, not replaced. (P5, H5)
- **Pulumi digest namespace is `wwwinfra:`** (not `ccinfra:`).
- **kubectl against the mini is READ-ONLY** except the explicit cutover steps.
- **All times LA local.**

---

## Phase 0 — File rescue + wipe (BLOCKING, separate workstream)

Tracked in the session task list. Gates everything: the PC is the target hardware. The
RAM-only live session's OOM killer repeatedly kills rsync, so the resume MUST be a
retry-until-clean loop (running now, `/tmp/video2.log`, marker `ALL_DONE_FOR_REAL`):
```bash
sudo nohup sh -c '
  S="/mnt/win/Users/Calum/Desktop"; D="/mnt/ext3/Gaming PC Backup 2026/Desktop"
  until rsync -a --no-links --no-perms --no-owner --no-group "$S/OBS/" "$D/OBS/"; do sleep 5; done
  until rsync -a --no-links --no-perms --no-owner --no-group "$S/P/"   "$D/P/";   do sleep 5; done
  sync; echo ALL_DONE_FOR_REAL' > /tmp/video2.log 2>&1 &
```
Verify: per-file checksum sample; `sync`; open a PDF/photo/video from the Mac. Only then
wipe the NVMe + flash Talos. **Nothing in Phase 1+ starts on hardware until the PC is free.**

---

## Phase 1 — Repo prep (no hardware; safe on `main` behind the `substrate` flag)

`substrate` defaults to `orbstack`, so these commits converge the *mini* unchanged. Each is
independently reviewable. **Exception:** Task 1 touches the shared build path — prove it on
a branch first (H6).

### Task 1: Multi-arch build, native two-runner manifest-merge (P1 + H6)

**Files:**
- Modify: `.github/workflows/ci.yml:256-338` (the four `build-*` jobs → matrix per arch +
  a merge job)
- Modify: `.github/actions/build-product-image/action.yml` (per-arch tag, no emulation)
- Test: `scripts/test-build-matrix.sh` (assert BOTH arch legs exist + a manifest-merge step)

**Interfaces:**
- Produces: multi-arch image **indexes** at `…:main`. The deploy step's
  `imagetools inspect --format '{{.Manifest.Digest}}'` reads the index digest
  (arch-agnostic) — no deploy change.

- [ ] **Step 1 (branch, not main):** create `feat/multiarch-build`. Do all of Task 1 there;
  it must go green on a branch before touching `main` (a red build here blocks every
  session's deploy).
- [ ] **Step 2: Write the guard** `scripts/test-build-matrix.sh`:
```bash
set -euo pipefail
f=.github/workflows/ci.yml
grep -q 'ubuntu-24.04-arm' "$f" || { echo "FAIL: arm64 leg must stay NATIVE"; exit 1; }
grep -q 'ubuntu-24.04\b'   "$f" || { echo "FAIL: amd64 leg missing"; exit 1; }
grep -q 'imagetools create' "$f" || { echo "FAIL: no manifest-merge step"; exit 1; }
echo "PASS"
```
- [ ] **Step 3: Run, expect FAIL.**
- [ ] **Step 4: Implement (native legs, no QEMU).** Each `build-*` job gets a
  `strategy.matrix.arch: [amd64, arm64]` with `runs-on: ${{ matrix.arch == 'arm64' &&
  'ubuntu-24.04-arm' || 'ubuntu-24.04' }}`, pushing a per-arch tag
  `…:${{ github.sha }}-${{ matrix.arch }}`. Add a dependent merge job per image:
  `docker buildx imagetools create -t …:main -t …:${{ github.sha }}
  …:${sha}-amd64 …:${sha}-arm64`. The action pushes the single-arch child; the merge job
  makes the index. **No `setup-qemu-action`** — both legs are native, so bun builds never
  emulate (avoids the OOM/timeout that would red the mini's deploy).
- [ ] **Step 5: Run guard, expect PASS.** Add it to the `test-unit` guards.
- [ ] **Step 6: Push the branch, `gh run watch --exit-status`, confirm** each image index
  has `linux/amd64` + `linux/arm64` (`imagetools inspect …:main`). Only then merge to main.

### Task 2: Talos machine config via talhelper (`infra/talos/`) — M1 fixed

**Files:** Create `infra/talos/talconfig.yaml`, `infra/talos/talsecret.sops.yaml`,
`infra/talos/README.md`; Test `scripts/test-talos-config.sh`.

**Interfaces:** Produces a validated single-node machine config for `talos-prod`.

- [ ] **Step 1: Pin a SecureBoot Image Factory schematic** with
  `siderolabs/nonfree-kmod-nvidia`, `siderolabs/nvidia-container-toolkit`,
  `siderolabs/iscsi-tools`, `siderolabs/tailscale`. Record the ID in `README.md`. Confirm
  the pinned Talos version's `tpm` disk-encryption key type works with SecureBoot before
  locking; else fall back to **unencrypted** (NOT a passphrase — §5/H4).
- [ ] **Step 2: Write `talconfig.yaml`** — the patch is a **single `machine:` block** (M1:
  no duplicate top-level key):
```yaml
clusterName: prod
endpoint: https://talos-prod.tail8c014d.ts.net:6443     # tailnet name, NOT homelab (P5)
nodes:
  - hostname: talos-prod
    controlPlane: true
    installDisk: /dev/nvme0n1
    schematic: { id: <SCHEMATIC_ID> }                    # from Step 1 (hardware-known)
    networkInterfaces:
      - interface: <2.5GbE-iface>                        # confirm on first boot
        addresses: [192.168.0.NNN/24]                    # static; = UniFi reservation (M3)
        routes: [{ network: 0.0.0.0/0, gateway: 192.168.0.1 }]
patches:
  - |-
    machine:
      certSANs: [talos-prod.tail8c014d.ts.net, 192.168.0.NNN]   # CI kubeconfig validates
      sysctls:
        fs.inotify.max_user_watches: "1048576"
        fs.inotify.max_user_instances: "8192"
      logging: {}                                         # only way off a shell-less box (§10)
      systemDiskEncryption:                               # drop this whole key if SecureBoot fights the board (H4)
        state:     { provider: luks2, keys: [{ tpm: {}, slot: 0 }] }
        ephemeral: { provider: luks2, keys: [{ tpm: {}, slot: 0 }] }
    cluster:
      discovery: { enabled: false }
      allowSchedulingOnControlPlanes: true
```
- [ ] **Step 3: `talhelper gensecret` → `talsecret.sops.yaml`, SOPS-encrypt** (repo age
  recipient). Never commit plaintext.
- [ ] **Step 4: Guard** `scripts/test-talos-config.sh`: `talhelper genconfig` → temp;
  `talosctl validate --mode metal -c <rendered>`. This catches the M1 duplicate-key case.
- [ ] **Step 5: Run, expect PASS. Step 6: Commit + push** (repo-only; mini untouched).

### Task 3: Retire mini-specific infra values behind `substrate` (P4 + C1 + M4)

**Files:** Modify `infra/src/services.ts:96-101,135-140,341-355,561-571`; `infra/src/index.ts`
(add `wwwinfra:substrate` + `wwwinfra:nodeIp` config); Test `infra/src/services.test.ts`.

**Interfaces:** Produces `haTarget(substrate, nodeIp)` and `plexAdvertiseIp(substrate,
nodeIp)`. Both use the mini values when `substrate==="orbstack"` and the **node LAN IP**
when `"talos"`. Default `orbstack` → mini byte-identical.

- [ ] **Step 1: Failing test** — note HA gets the **node LAN IP, not loopback** (C1: api/
  worker are normal pods; `127.0.0.1` would be their own loopback):
```ts
test("ha target is the node LAN IP on talos (api/worker are non-hostNetwork pods)", () => {
  expect(haTarget("talos", "192.168.0.NNN")).toBe("192.168.0.NNN");
  expect(haTarget("orbstack", "192.168.0.NNN")).toBe("homelab.tail8c014d.ts.net");
});
test("plex advertise uses node LAN IP on talos", () => {
  expect(plexAdvertiseIp("talos", "192.168.0.NNN")).toBe("http://192.168.0.NNN:32400");
});
```
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Add `wwwinfra:substrate` (default `"orbstack"`) and
  `wwwinfra:nodeIp` config in `index.ts`; thread both to `services.ts`. Replace the
  hardcoded `HA_TAILNET_FQDN` in the `ha` ExternalName (line 566) with `haTarget(...)` and
  Plex `ADVERTISE_IP` (line 355) with `plexAdvertiseIp(...)`. The `ha` Service stays an
  ExternalName pointing at the node LAN IP on Talos (a hostNetwork HA binds `:8123` on the
  node netns, reachable at that IP from any pod).
- [ ] **Step 4: Run, expect PASS. Step 5: `bun run typecheck`.**
- [ ] **Step 6: Commit + push.** With `substrate=orbstack` the next `pulumi up` shows **no
  `ha`/`plex` diff** — verify.

### Task 4: MetalLB + local-path-provisioner + HA + GPU RuntimeClass + backup cron (behind flag)

**Files:** Create `infra/src/metallb.ts`, `infra/src/local-path.ts`,
`infra/src/homeassistant.ts`, `infra/src/nvidia.ts`; Modify `infra/src/crons.ts`,
`infra/src/index.ts`, `infra/src/cluster.ts`; Test `scripts/test-talos-substrate.sh`.

**Interfaces:** All no-ops when `substrate==="orbstack"`; live only on `"talos"`.

- [ ] **Step 1: local-path-provisioner (H2).** Talos ships **no** storage provisioner —
  install rancher `local-path-provisioner` (pinned manifest) and mark its StorageClass
  **default**, so the CNPG/`plex-config`/`ha-config` `local-path` PVCs bind. Namespace
  `local-path-storage` (L1: created here, outside the closed `InfraNamespaceName` map).
- [ ] **Step 2: MetalLB.** Operator (pinned) + `IPAddressPool` (single reserved LAN range,
  M3) + `L2Advertisement`, namespace `metallb-system` (L1). `api`/`plex` keep
  `type: LoadBalancer`.
- [ ] **Step 3: `nvidia` RuntimeClass (M2).** Create the `RuntimeClass` object and extend
  the Plex `WorkloadSpec` (`services.ts:334-374`) to carry `runtimeClassName: "nvidia"` +
  a `nvidia.com/gpu: 1` limit (Talos-only, behind the flag).
- [ ] **Step 4: HA manifest.** `Deployment` `ghcr.io/home-assistant/home-assistant:stable`
  (multi-arch upstream), `hostNetwork:true`, `dnsPolicy:ClusterFirstWithHostNet`, `/config`
  ← `ha-config` PVC (`local-path`, **20Gi** — recorder history, M8), resource headroom, its
  own namespace (L1). No Supervisor. Comment: PVC seeded from the **stopped-HA snapshot** at
  cutover (C1/Task 11), and an **immutable copy kept on the NAS first** (M8).
- [ ] **Step 5: `ha-config` backup cron (§7).** In `crons.ts`, a CronJob mirroring
  `postgresBackupCronSpec`'s NFS pattern: `sqlite3 .backup` the recorder + `tar` `.storage`
  → Synology NFS, `set -eo pipefail`. Replaces the Supervisor snapshot the container loses.
- [ ] **Step 6: Guard** asserts local-path/MetalLB/HA/RuntimeClass/backup-cron absent on
  `orbstack`, present on `talos`. **Typecheck + test + commit + push** (mini unaffected).

### Task 5: Postgres restore-proof rehearsal (folded into Task 6's VM — M6)

Deferred to run **inside Phase 1.5** where a real CNPG venue exists (M6 sequencing). Uses
`scripts/pg-snapshot-restore.sh`, the safety dump `scratchpad/cc-control_center-20260724.dump`,
and baseline `cc-rowcounts-20260724.tsv`. Deliverable: a written **cutover runbook**
(`docs/superpowers/plans/cutover-runbook.md`) — fresh `pg_dump` → restore → `--compare-counts`
vs a same-moment live count → go/no-go. Commit the runbook.

---

## Phase 1.5 — Validate in a throwaway Talos VM (§9)

### Task 6: Local Talos VM dress-rehearsal (+ Task 5 PG proof) — L3 scoped

- [ ] **Step 1:** `talosctl cluster create --name talos-vm …`.
- [ ] **Step 2:** Apply the rendered manifests with `substrate:talos` at the VM: local-path,
  MetalLB, CNPG, api/web/worker/go2rtc/plex/cloudflared(**replicas:0**)/cert-manager, HA.
- [ ] **Step 3 (Task 5):** restore the safety dump into the VM's CNPG; `--compare-counts` vs
  `cc-rowcounts-20260724.tsv` → zero mismatches. Write the cutover runbook.
- [ ] **Step 4 (L3, scoped):** confirm a kubeconfig built from **Talos PKI** reaches the API
  over `:6443` with a certSAN match. NOTE: the VM joins the tailnet as a *different* node —
  the real `talos-prod` name/certSAN/Tailscale-extension path is only fully provable on
  hardware (Task 7). Do not overclaim.
- [ ] **Step 5:** record hardware-only gaps (GPU, mDNS discovery, TPM, real tailnet name).
  `talosctl cluster destroy`. **Step 6:** commit config fixes the VM surfaced.

---

## Phase 2 — Hardware bring-up (needs Calum; house untouched)

### Task 7: UniFi reservations, flash, BIOS, boot Talos (M3 + H4)

- [ ] **Step 1 (Calum, in UniFi — M3):** create a DHCP **reservation** for the node's MAC at
  `192.168.0.NNN`, and **exclude the MetalLB pool** from the DHCP range. Verify both.
- [ ] **Step 2 (Calum, at the desk):** reflash the boot USB with the SecureBoot Talos image.
  **Finalize BIOS BEFORE first encrypted boot (H4):** enable fTPM, enable Secure Boot, set
  USB→NVMe boot order. Once, at the desk, monitor attached.
- [ ] **Step 3:** `talhelper` → `talosctl apply-config --insecure`; `talosctl bootstrap`;
  `talosctl kubeconfig`. `kubectl --context talos-prod get nodes` Ready.
- [ ] **Step 4:** confirm the Tailscale extension put the node on the tailnet as
  `talos-prod`; `kubectl` over `:6443` via the tailnet works. Confirm encryption active
  (`talosctl get systemdiskencryption`) or consciously unencrypted (H4 fallback).
- [ ] **Step 5:** stay at the desk until HA cutover verified. **Rollback:** none — mini
  untouched; powering the PC off is free.

### Task 8: GPU + storage + MetalLB substrate

- [ ] **Step 1:** NVIDIA device plugin; `kubectl describe node` shows `nvidia.com/gpu`;
  `nvidia-smi` test pod sees the 3060.
- [ ] **Step 2:** local-path-provisioner running + default StorageClass; MetalLB pool ARPs
  on the LAN.
- [ ] **Step 3:** throwaway pod mounts each of the four Synology NFS PVs from the Talos node
  netns — confirm reachable.
- [ ] **Step 4:** CNPG operator installed. **Rollback:** delete Talos workloads; mini safe.

---

## Phase 3 — Stateless workloads + deploy path (house still on the mini)

### Task 9: Repoint CI to Talos, deploy the stateless stack (H1/H3/H4/H5/L2)

**Files:** Modify `secrets/vault.yaml` (`KUBECONFIG__B64` → **two-context** blob, once),
`Pulumi.prod.yaml` (`wwwinfra:kubeContext`, `wwwinfra:substrate`, `wwwinfra:nodeIp`,
`wwwinfra:cloudflaredReplicas`), Tailscale ACL.

- [ ] **Step 1 (H4/H5, prep, reversible):** rebuild `KUBECONFIG__B64` to embed **both**
  contexts (mini `cc-homelab` + `talos-prod`), default `current-context` still the mini.
  **ADD** a `tag:ci` ACL grant to `talos-prod:6443` **without removing** `homelab:26443`.
  Commit. CI still deploys the mini (context unchanged) — nothing cuts over yet.
- [ ] **Step 2 (H3, first apply):** with `wwwinfra:kubeContext=talos-prod` **and
  `imageDigests` EMPTY**, run `pulumi up` once. Empty digests skips
  `verifyLiveGhcrPullSecrets` (index.ts:107 throws on a fresh cluster that lacks the
  `…-ghcr-pull` secret) and lets this apply **create** that secret. Seeds local-path,
  MetalLB, namespaces, the GHCR pull secret.
- [ ] **Step 3 (deploy stateless, H1):** set `wwwinfra:substrate=talos`,
  `wwwinfra:nodeIp=192.168.0.NNN`, and **`wwwinfra:cloudflaredReplicas=0`** (services.ts:402
  — a Talos cloudflared at >0 would grab the live tunnel token and split-brain external
  users across both clusters). `pulumi up` (digest-pinned now) deploys api/web/worker/
  go2rtc/plex/cert-manager on Talos; cloudflared present at 0. Mini still serves the house.
- [ ] **Step 4:** verify each Talos workload healthy; `api /up` green; go2rtc streams under
  hostNetwork; cert-manager issued `api`'s cert (DNS-01, IP-independent — L2). HA tiles
  still error (HA on mini; `ha` now targets the Talos node which has no HA yet) — expected.
- [ ] **Step 5 (make Talos the deploy target):** flip `wwwinfra:kubeContext=talos-prod` as
  the committed default so CI deploys Talos. **Rollback:** revert that one line →
  `cc-homelab`; mini stays fully deployable throughout (H4). Announce the main-push quiet
  window (Global Constraints).

### Task 10: Postgres cutover

- [ ] **Step 1:** fresh read-only `pg_dump` of `control_center` from the mini + a same-moment
  row-count.
- [ ] **Step 2:** restore into Talos CNPG; `--compare-counts` vs the same-moment count →
  zero mismatches (runbook, Task 5).
- [ ] **Step 3:** verify weight/weather/frontend_log tiles read correctly on Talos.
  **Rollback:** point the app back at the mini DB (untouched, live).

---

## Phase 4 — HA cutover (house dark briefly) + finish

### Task 11: HA cutover — C2 watchdog gate + C1 + M7/M8

- [ ] **Step 0 (C2 — DO NOT SKIP):** on the mini, **stop/disable `ha-watchdog`** (the
  service that restarts HA whenever `:8123` is down — MEMORY `ha-clean-stop-unproven-
  watchdog-live`) AND turn OFF the HA container/add-on watchdog in Supervisor. Confirm HA
  stays down for **> one watchdog interval** after a test stop. Without this, the stop in
  Step 1 *triggers* a restart → both HAs on HomeKit/Thread/ESPHome → irreversible `.storage`
  corruption.
- [ ] **Step 1:** announce the house-dark window. `ha core stop`; **verify stopped**
  (`:8123` refuses) and **stays** stopped (watchdog confirmed off, Step 0).
- [ ] **Step 2 (C1-copy / M8):** ONLY NOW take the authoritative `/config` — a stopped-HA
  snapshot / `sqlite3 home-assistant_v2.db ".backup"`. Write an **immutable copy to the NAS
  first**, then load `.storage` + YAML + recorder into the `ha-config` PVC.
- [ ] **Step 3:** start the Talos HA container. It reinstalls custom-integration pip deps
  into `/config/deps` on boot.
- [ ] **Step 4 (M8 verify):** Hue/Shelly/HomeKit/Apple TV/Sonos/Tesla/ESPHome/Thread
  reconnect; **`renpho_fitness_scale_ble` entity resolves**; go2rtc cameras work; **wall
  panel live, lights respond. Calum confirms it feels right.**
- [ ] **Step 5:** confirm the `ha-config` backup cron runs once to the Synology.
- **Rollback (M7 — window is explicit, NOT one-command):** clean **only before the Talos HA
  re-pairs HomeKit/Thread** (those re-key on pairing, staling the mini's `.storage`). Within
  that window: stop Talos HA, re-enable the mini watchdog, `start-haos.sh` on the mini,
  revert `wwwinfra:kubeContext`→`cc-homelab` + `substrate`→`orbstack`, `pulumi up`. After
  re-pairing, rollback means re-pairing those devices back to the mini by hand.

### Task 12: Plex GPU + cold-spare the mini

- [ ] **Step 1:** confirm Plex hardware transcode on the 3060 (RuntimeClass + `nvidia.com/gpu`
  from Task 4; Plex Pass required for NVENC); `ADVERTISE_IP` = Talos node IP; verify Apple
  TV playback + a real transcode.
- [ ] **Step 2:** move the PC to the cupboard (one power-cycle; static IP + reservation →
  identical return).
- [ ] **Step 3:** power down the mini. **Do not wipe.** Cold spare; HAOS qcow2 +
  `start-haos.sh` intact.
- [ ] **Step 4:** docs: `CODEBASE_OVERVIEW.md` (deploy path, arch, substrate), `AGENTS.md`
  Infra, `docs/homelab-host.md`; fix stale `ccinfra:`→`wwwinfra:`.
- [ ] **Step 5 (optional, post-soak):** once rollback is truly abandoned, drop the arm64
  build leg (reverse Task 1) and the `orbstack` `substrate` branch.

---

## Self-Review (against the spec + plan review)

**Spec coverage:** §2→T2,7,8,9,11,12. §4 P1→T1, P2→T2/T9, P3→T4/T11, P4→T3, P5→T2/T9. §5
(TPM/H4→T2/T7, Flannel/talhelper/static-IP→T2, MetalLB/M7→T4/T9). §6→T5/T10/T11 (+maps/
plex-config re-provision T9). §7→T4/T11. §8→Phases 0–4. §9→T6. §10 deferred→untasked
(correct). §11→T7/T11. §12 risks→rollback lines.

**Plan-review coverage:** C1→T3, **C2→T11 Step 0**, H1→T9 Step 3, H2→T4 Step 1/T8, H3→T9
Step 2, H4→Global + T9 Step 1/5, H5→T9 Step 1, H6→T1 (branch-first native), M1→T2 Step 2,
M2→T4 Step 3, M3→T7 Step 1, M4→T3 Step 3, M5→**no-op (already handled)**, M6→T5-into-T6,
M7→T11 rollback, M8→T4 Step 4/T11 Step 2, L1→T4 namespaces, L2→T9 Step 4, L3→T6 Step 4.

**Open decisions still Calum's:** SQLite-in-PVC vs CNPG-now (default SQLite); encryption vs
unencrypted if SecureBoot fights the board (T2/T7); the Task 1 build mechanism is now fixed
to native two-runner (no decision needed).
