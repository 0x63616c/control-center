# Local-LVM Storage Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace local-path-provisioner with OpenEBS LocalPV-LVM on the home-server Talos node so every PVC's declared size is actually enforced (a 10Gi PVC is 10Gi — writes fail at the limit instead of silently consuming the node disk), with online expansion and real `kubelet_volume_stats`.

**Architecture:** Cap Talos's EPHEMERAL partition at 200GiB via machine config (it currently owns the whole ~1TB NVMe), leave the remaining ~730GiB as a raw partition backing an LVM volume group `storage`, and install OpenEBS LocalPV-LVM as the cluster's only StorageClass (`local-lvm`, thick-provisioned, xfs, expandable). Because EPHEMERAL cannot shrink online **and etcd lives on EPHEMERAL**, the cutover is a one-time full-cluster rebuild: back up all data → `talosctl reset` → re-bootstrap → `pulumi up` → restore data. This is the same shape as the 2026-07-25 homelab→home-server cutover, which is the playbook precedent.

**Tech Stack:** Talos v1.13 (`RawVolumeConfig` + `VolumeConfig` maxSize), talhelper, OpenEBS LocalPV-LVM (lvm-localpv CSI), Pulumi `@pulumi/kubernetes` (hand-written manifests per ADR-0007 — pinned-URL ConfigFile for the upstream operator, never Helm), CloudNativePG, pg_dump/pg_restore.

## Global Constraints

- **"prod" = the `home-server` Talos node** (`192.168.0.5`, single control-plane, amd64). No other environment; the maintenance window takes the whole house stack down.
- **NO SSH into the node** — `talosctl` + `kubectl` only. `TALOSCONFIG=$PWD/infra/talos/clusterconfig/talosconfig`, regenerated per session via `talhelper genconfig`.
- **Physical presence required for the cutover tasks (7–10):** there is NO remote power-cycle path; a wedged boot needs hands on the machine (see node-IP-drift incident).
- **etcd data is on EPHEMERAL.** Single control-plane ⇒ wiping EPHEMERAL destroys all cluster state. The cutover is a full re-bootstrap + `pulumi up`, not a node reboot.
- Hand-written Pulumi manifests, no Helm, no operator CRD sprawl beyond what lvm-localpv itself ships (ADR-0007 precedent).
- Never read secret values; vault stays SOPS (`secret/vault.yaml`).
- Branch → PR → merge for every code task; **but do NOT merge Tasks 2–5 to `main` until Task 6's gate says so** — merging deploys, and the lvm-localpv DaemonSet will crashloop with no VG present. Tasks 2–5 accumulate on one branch, merged during the window.
- Sizes locked by measurement (2026-07-27): EPHEMERAL cap **200GiB**; VG `storage` gets the rest (~730GiB); PVC sizes in Task 4/5 tables.
- NAS NFS export `192.168.0.218:/volume1/Homelab` (verified live 2026-07-27 — pg-backup jobs green against it; the ".219" note in memory is the DSM UI address).

## File Structure

- `infra/talos/talconfig.yaml` — EPHEMERAL cap + raw storage partition (machine-config source of truth).
- `infra/src/lvm-localpv.ts` — NEW: lvm-localpv operator (pinned-URL ConfigFile) + `local-lvm` StorageClass + `openebs` namespace.
- `infra/test/lvm-localpv.test.ts` — NEW: render tests for the above.
- `infra/program.ts` — wire `installLvmLocalPv`, gated to `substrate === "talos"` (same gate as `installTemporal`).
- `packages/platform/src/index.ts:594` — default `storageClass` flips `"local-path"` → `"local-lvm"`.
- `infra/src/temporal.ts:438` — temporal-postgres storage `"local-path"` → `"local-lvm"`.
- `infra/src/observability/*.ts`, `infra/src/services.ts`, `infra/src/homeassistant.ts`, `infra/src/db-ui.ts` — any PVC that names `local-path` explicitly flips to `local-lvm`; PVCs that omit storageClassName ride the new cluster default.
- `scripts/storage-migration/` — NEW: `backup-pvcs.sh`, `restore-pvcs.sh`, `vg-bootstrap.yaml` (privileged one-shot pod), `dump-temporal-dbs.sh`.
- `docs/runbooks/local-lvm-cutover.md` — NEW: the maintenance-window runbook (Task 6 writes it; Tasks 7–10 execute it).
- `docs/adr/0009-enforced-local-storage-lvm.md` — NEW: the decision record.

---

### Task 1: ADR-0009 — enforced local storage via LocalPV-LVM

**Files:**
- Create: `docs/adr/0009-enforced-local-storage-lvm.md`

**Interfaces:**
- Produces: the decision record every later task cites; no code.

- [ ] **Step 1: Write the ADR** following the house style of `docs/adr/0007-hand-rolled-observability-stack.md` (declarative title, prose, "Rejected", "Consequences"). Content — decision: local-path is replaced by OpenEBS LocalPV-LVM on a dedicated raw partition; EPHEMERAL capped at 200GiB (measured residual ~38GB after PVC data leaves: containerd 11.7GB + logs + kubelet/etcd ~26GB); VG `storage` ~730GiB; StorageClass `local-lvm`, thick-provisioned (a reservation IS the point — thin would reintroduce "capacity is a suggestion"), xfs, `allowVolumeExpansion: true`, cluster default; local-path deleted entirely; NFS RWX statics on the Synology unchanged. Rejected: local-path XFS-quota hacks (upstream wontfix, [local-path#21](https://github.com/rancher/local-path-provisioner/issues/21), no-op expansion [#190](https://github.com/rancher/local-path-provisioner/issues/190)); TopoLVM (capacity-aware scheduling is a multi-node feature); Longhorn single-replica (iscsi extensions + privileged + data-path overhead buying replication one node can't use); ZFS (system extension + reinstall for features LVM covers; no snapshot requirement). Consequences: one-time full-cluster rebuild (etcd on EPHEMERAL); `kubelet_volume_stats` finally exist for local volumes (closes the #212 gap); PVC sizes become real and must be sized honestly (Task 4/5 tables); EPHEMERAL cap is the one irreversible knob — changing it means another wipe.
- [ ] **Step 2: Commit** on branch `issue-<N>-local-lvm-storage` (file the tracking issue first with `/create-ticket` if none exists; label `area/infra` + `type/design`): `git add docs/adr/0009-enforced-local-storage-lvm.md && git commit -m "docs: ADR-0009 enforced local storage via LocalPV-LVM"` — this task MAY merge to main immediately (docs only).

### Task 2: Talos machine config — EPHEMERAL cap + raw storage partition

**Files:**
- Modify: `infra/talos/talconfig.yaml`

**Interfaces:**
- Produces: partition label `storage` (raw, no filesystem) that Task 7 turns into the LVM PV; EPHEMERAL `maxSize: 200GiB` effective only after the Task 8 wipe.

- [ ] **Step 1: Add the volume documents** as talhelper inline patches on the node (Talos v1.13 syntax; both are additional multi-doc machine-config documents):

```yaml
# under the home-server node's patches in talconfig.yaml
- |-
  apiVersion: v1alpha1
  kind: VolumeConfig
  name: EPHEMERAL
  provisioning:
    maxSize: 200GiB
- |-
  apiVersion: v1alpha1
  kind: RawVolumeConfig
  name: storage
  provisioning:
    diskSelector:
      match: system_disk
    minSize: 500GiB
    grow: true
```

- [ ] **Step 2: Regenerate + dry-run.** `cd infra/talos && talhelper genconfig`, then `talosctl apply-config --dry-run --file clusterconfig/<node>.yaml`. Expected: config accepted; NOTE in output (and in the commit message) that the EPHEMERAL cap does NOT shrink the live partition — it takes effect at re-provision (Task 8). The RawVolumeConfig may also not provision until space exists; that is expected.
- [ ] **Step 3: Verify against docs** that `RawVolumeConfig` exists in the server's Talos version (`talosctl version` → v1.13.7 ✓, raw volumes are 1.11+). If the apply-config dry-run rejects the doc kind, STOP and re-check the schema at https://docs.siderolabs.com/talos/v1.13/configure-your-talos-cluster/storage-and-disk-management/disk-management — do not guess field names.
- [ ] **Step 4: Commit** (branch only, do not merge): `git add infra/talos/talconfig.yaml && git commit -m "infra(talos): cap EPHEMERAL at 200GiB, add raw storage partition for LVM"`.

### Task 3: Pulumi — lvm-localpv operator + local-lvm StorageClass

**Files:**
- Create: `infra/src/lvm-localpv.ts`
- Create: `infra/test/lvm-localpv.test.ts`
- Modify: `infra/program.ts` (wire, talos-gated)

**Interfaces:**
- Consumes: nothing new (mirrors how `cnpgOperator` is installed via pinned-URL ConfigFile).
- Produces: `installLvmLocalPv(args: { provider: k8s.Provider }): { operator: k8s.yaml.v2.ConfigFile; storageClass: k8s.storage.v1.StorageClass }`; StorageClass name **`local-lvm`**, VG name **`storage`** — Tasks 4/5/7 depend on these two literal names.

- [ ] **Step 1: Write the render test first** (`infra/test/lvm-localpv.test.ts`, mirror the mock pattern of `infra/test/temporal.test.ts:20-50`):

```ts
import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, test } from "vitest";

pulumi.runtime.setMocks({
  newResource(args: pulumi.runtime.MockResourceArgs) {
    return { id: `${args.name}-id`, state: args.inputs };
  },
  call() {
    return {};
  },
});

let mod: typeof import("../src/lvm-localpv.ts");
beforeAll(async () => {
  mod = await import("../src/lvm-localpv.ts");
});

function get<T>(r: pulumi.Resource, prop: string): Promise<T> {
  const out = (r as unknown as Record<string, pulumi.Output<T>>)[prop];
  return new Promise((resolve) => {
    out.apply((v) => {
      resolve(v);
      return v;
    });
  });
}

describe("installLvmLocalPv", () => {
  test("local-lvm StorageClass: enforced, expandable, thick, xfs, default", async () => {
    const { storageClass } = mod.installLvmLocalPv({ provider: new pulumi.ProviderResource("kubernetes", "p", {}) as never });
    expect(await get(storageClass, "provisioner")).toBe("local.csi.openebs.io");
    expect(await get(storageClass, "allowVolumeExpansion")).toBe(true);
    expect(await get(storageClass, "reclaimPolicy")).toBe("Delete");
    expect(await get(storageClass, "volumeBindingMode")).toBe("WaitForFirstConsumer");
    const params = await get<Record<string, string>>(storageClass, "parameters");
    expect(params).toMatchObject({ storage: "lvm", volgroup: "storage", fsType: "xfs" });
    expect(params.thinProvision ?? "no").toBe("no");
    const meta = await get<{ annotations?: Record<string, string> }>(storageClass, "metadata");
    expect(meta.annotations?.["storageclass.kubernetes.io/is-default-class"]).toBe("true");
  });
});
```

- [ ] **Step 2: Run it, expect failure** (`bun run --cwd infra test -- lvm-localpv`): module not found.
- [ ] **Step 3: Implement `infra/src/lvm-localpv.ts`:**

```ts
/**
 * OpenEBS LocalPV-LVM (ADR-0009): the storage layer that makes PVC capacity
 * REAL. Each PVC is an LVM logical volume in VG `storage` (raw partition
 * carved next to the capped EPHEMERAL) — writes fail at the declared size,
 * expansion is online, kubelet_volume_stats exist. Operator installed from
 * the pinned upstream manifest (ADR-0007 pattern: ConfigFile, never Helm).
 */
import * as k8s from "@pulumi/kubernetes";

const LVM_LOCALPV_VERSION = "1.7.0"; // pin; bump deliberately
const OPERATOR_URL = `https://raw.githubusercontent.com/openebs/lvm-localpv/lvm-localpv-${LVM_LOCALPV_VERSION}/deploy/lvm-operator.yaml`;

/** The VG name Task 7's vg-bootstrap pod creates; also in the SC params. */
export const VOLUME_GROUP = "storage";
export const STORAGE_CLASS_NAME = "local-lvm";

export interface LvmLocalPvArgs {
  provider: k8s.Provider;
}

export function installLvmLocalPv(args: LvmLocalPvArgs) {
  const opts = { provider: args.provider };

  const operator = new k8s.yaml.v2.ConfigFile("lvm-localpv-operator", { file: OPERATOR_URL }, opts);

  const storageClass = new k8s.storage.v1.StorageClass(
    STORAGE_CLASS_NAME,
    {
      metadata: {
        name: STORAGE_CLASS_NAME,
        // The ONLY StorageClass (local-path is deleted, ADR-0009): default so
        // every PVC that names nothing lands on enforced storage.
        annotations: { "storageclass.kubernetes.io/is-default-class": "true" },
      },
      provisioner: "local.csi.openebs.io",
      // Thick on purpose: a 10Gi PVC RESERVES 10Gi. Thin would reintroduce
      // "capacity is a suggestion" through the back door.
      parameters: { storage: "lvm", volgroup: VOLUME_GROUP, fsType: "xfs" },
      allowVolumeExpansion: true,
      reclaimPolicy: "Delete",
      volumeBindingMode: "WaitForFirstConsumer",
    },
    { ...opts, dependsOn: [operator] },
  );

  return { operator, storageClass };
}
```

- [ ] **Step 4: Wire into `infra/program.ts`** next to the `installTemporal` call, inside the same `substrate === "talos"` gate: `const lvm = installLvmLocalPv({ provider });` (export in the program's outputs the way temporal's resources are).
- [ ] **Step 5: Run tests + typecheck** (`bun run --cwd infra test`, `bun run typecheck`): PASS. Also `pulumi preview --stack home-server` from `infra/` — expect the operator + SC as CREATE, nothing else churned. Paste the preview summary into the PR body later.
- [ ] **Step 6: Commit** (branch only, do not merge): `git commit -m "infra: OpenEBS lvm-localpv operator + local-lvm default StorageClass (ADR-0009)"`.

### Task 4: Flip every database/PVC declaration to local-lvm with honest sizes

**Files:**
- Modify: `packages/platform/src/index.ts:594` (default storageClass)
- Modify: `infra/src/temporal.ts:438`
- Modify: wherever `grep -rn '"local-path"' infra/src packages/platform` still hits after the two above (observability stack, db-ui, homeassistant, services)

**Interfaces:**
- Consumes: `STORAGE_CLASS_NAME = "local-lvm"` (Task 3).
- Produces: every PVC-bearing declaration naming `local-lvm` (or nothing, riding the default), with the sizes below — the restore runbook (Task 6) copies this table.

Locked sizes (thick-reserved; expansion is a one-line PVC edit later, so start honest-but-modest):

| Volume | Size |
|---|---|
| control-center-postgres | 10Gi |
| temporal-postgres | 10Gi |
| home-assistant-postgres | 5Gi |
| prometheus-data | 30Gi |
| loki-data | 30Gi |
| plex-config | 10Gi |
| maps | 5Gi |
| ha-config | 5Gi |
| grafana-data | 2Gi |
| pgadmin-data | 1Gi |

Total reserved ≈ 108Gi of ~730Gi.

- [ ] **Step 1:** `grep -rn '"local-path"' infra packages` — enumerate every hit. Flip `packages/platform/src/index.ts:594` default to `"local-lvm"`, `infra/src/temporal.ts:438` to `"local-lvm"`, and each remaining explicit `"local-path"` to `"local-lvm"`. Where a PVC's requested size differs from the table above, set the table's value.
- [ ] **Step 2:** Update any infra tests pinning `"local-path"` or old sizes (`grep -rn "local-path" infra/test`) to the new expectations — the test edit states the NEW contract, not a deleted assertion.
- [ ] **Step 3: Run** `bun run --cwd infra test && bun run typecheck`: PASS. `grep -rn '"local-path"' infra packages` → zero hits.
- [ ] **Step 4: Commit** (branch only, do not merge): `git commit -m "infra: all PVCs on local-lvm with enforced sizes (ADR-0009)"`.

### Task 5: Migration scripts — backup, VG bootstrap, restore

**Files:**
- Create: `scripts/storage-migration/backup-pvcs.sh`
- Create: `scripts/storage-migration/dump-temporal-dbs.sh`
- Create: `scripts/storage-migration/vg-bootstrap.yaml`
- Create: `scripts/storage-migration/restore-pvcs.sh`

**Interfaces:**
- Consumes: VG name `storage`, partition label `storage` (Task 2/3); NAS export `192.168.0.218:/volume1/Homelab`.
- Produces: NAS staging dir `backups/world-wide-webb/storage-migration/<date>/` holding `pvc-files/` (rsync of every local-path PVC dir) and `dumps/` (`control_center.sql.gz`, `temporal.sql.gz`, `temporal_visibility.sql.gz`, `home_assistant.sql.gz`).

- [ ] **Step 1: `backup-pvcs.sh`** — runs a privileged pod (image `instrumentisto/rsync-ssh` or busybox+rsync) mounting hostPath `/opt/local-path-provisioner` read-only and the NAS NFS export, rsync-a'ing every `pvc-*` dir into `pvc-files/`. Idempotent (re-run = re-sync). Script refuses to run unless `kubectl get nodes` answers. ~4.3GB total, minutes.
- [ ] **Step 2: `dump-temporal-dbs.sh`** — `kubectl -n <ns> exec <cnpg-primary> -c postgres -- pg_dump -U postgres -d <db> | gzip > dumps/<db>.sql.gz` for all four databases (control_center, temporal, temporal_visibility, home_assistant), landing on the NAS via a local mount or piping through the pod to the NFS staging pod. NOTE in the header: the nightly pg-backup cron only dumps `control_center` — the temporal + HA dbs have NO other backup, this script is their only lifeline through the wipe.
- [ ] **Step 3: `vg-bootstrap.yaml`** — one privileged pod (hostPID, image `alpine:3.20` + `apk add lvm2`, or a pinned lvm2 image) that runs, against the raw partition Talos created (`/dev/disk/by-partlabel/storage`):

```sh
pvcreate /dev/disk/by-partlabel/storage
vgcreate storage /dev/disk/by-partlabel/storage
vgs storage
```

  Pod is `restartPolicy: Never`, deleted after success. Header comment: run ONCE, after the Task 8 wipe, before `pulumi up` creates the first PVC.
- [ ] **Step 4: `restore-pvcs.sh`** — inverse of backup: for each NEW `local-lvm` PVC that carries plain files (maps, plex-config, ha-config, grafana, prometheus, loki, pgadmin), spin a pod mounting the PVC + the NAS staging dir and rsync the matching `pvc-files/` content in. Postgres databases are NOT rsynced — they restore via `gunzip -c dumps/<db>.sql.gz | kubectl exec -i <new-primary> -c postgres -- psql -U postgres -d <db>` after CNPG creates the empty clusters (the schema-setup Jobs in temporal.ts recreate temporal's schema; restore the dumps AFTER those complete).
- [ ] **Step 5: Verify scripts are inert** — `shellcheck scripts/storage-migration/*.sh` clean; none of them run anything at commit time.
- [ ] **Step 6: Commit** (branch only): `git commit -m "infra: storage-migration backup/vg-bootstrap/restore scripts (ADR-0009)"`.

### Task 6: Cutover runbook (gate for everything above)

**Files:**
- Create: `docs/runbooks/local-lvm-cutover.md`

**Interfaces:**
- Consumes: everything from Tasks 2–5 by exact name.
- Produces: the ordered checklist Tasks 7–10 execute. **Merging the accumulated branch to `main` is step 3 OF THE WINDOW, not before** (merge deploys; lvm-localpv without a VG crashloops, and CNPG clusters pointed at `local-lvm` before it exists would wedge — the pre-window cluster must never see these manifests).

- [ ] **Step 1: Write the runbook** with these ordered sections (each references the exact script/command from prior tasks): (0) preconditions — Calum physically home, panel/house users warned, `git status` clean everywhere; (1) fresh backups: run `backup-pvcs.sh` + `dump-temporal-dbs.sh`, then VERIFY: listed file sizes > 0, `gunzip -t` every dump, spot-`head` one rsync'd file; (2) scale down stateful writers (`kubectl scale deploy ... --replicas=0` for api/worker/temporal-worker; CNPG clusters left running for the dumps, then hibernated); (3) merge the accumulated branch PR → main; CI runs but the deploy targets the OLD cluster and will partially fail or be raced by the wipe — that is accepted and documented, the authoritative apply is step 6; (4) `talosctl apply-config` the Task-2 machine config, then `talosctl reset --system-labels-to-wipe EPHEMERAL --reboot` (STATE/META survive; **etcd content does not** — the cluster comes back EMPTY); (5) node returns: `talosctl bootstrap`, wait for `kubectl get nodes` Ready, confirm partitions via `talosctl get discoveredvolumes` (EPHEMERAL ~200GiB, `storage` raw ~730GiB); (6) `kubectl apply -f scripts/storage-migration/vg-bootstrap.yaml`, wait Complete, confirm `vgs` output in its logs; (7) full `pulumi up --stack home-server` from `infra/` (this is the homelab-cutover motion: everything recreates — namespaces, secrets from vault, CNPG operator + clusters on `local-lvm`, temporal, observability, workloads); `infra/cloudflare` needs NO re-up (separate project, tunnel config unchanged — the connector reconnects when cloudflared pods return); (8) restore data: wait for CNPG primaries + temporal schema jobs, run the psql restores from `restore-pvcs.sh`'s docs + rsync the file PVCs, then restart consumers; (9) verification checklist (Task 9); (10) rollback note: there is no rollback past step 4 — the old EPHEMERAL is gone; recovery from failure = same restore path onto whatever storage exists, which is why step 1's verification is mandatory.
- [ ] **Step 2: Commit + open the PR** for the accumulated branch (Tasks 2–6) titled for the migration, PR body carrying the pulumi preview from Task 3 and a bold "MERGE ONLY DURING THE CUTOVER WINDOW (runbook step 3)". Do not merge.

### Task 7–10: Execute the window (operational, from the runbook)

**Files:** none (operations; the runbook is the source).

- [ ] **Task 7: Backups + verification** — runbook steps 0–2. Hard gate: every dump passes `gunzip -t` and the rsync listing matches `kubectl get pvc -A` before anything destructive.
- [ ] **Task 8: Wipe + re-bootstrap** — runbook steps 3–6. Ends with: node Ready, EPHEMERAL 200GiB, VG `storage` ~730GiB with 0 LVs.
- [ ] **Task 9: Rebuild + restore + verify** — runbook steps 7–9. Verification checklist (all must pass): `kubectl get sc` shows ONLY `local-lvm` (default); `kubectl get pvc -A` all Bound with the Task-4 sizes; `kubectl exec` into control-center-postgres → `df -h /var/lib/postgresql/data` shows the PVC size (e.g. **10G, NOT 929G — the whole point**); row-count spot-checks against pre-dump numbers (`select count(*) from incoming_webhook` etc.); enforcement proof: on a scratch 1Gi PVC, `dd if=/dev/zero of=/mnt/f bs=1M count=2000` FAILS with ENOSPC at ~1Gi; `kubelet_volume_stats_capacity_bytes` present in Prometheus for local-lvm PVCs; temporal schedules reconciled (worker logs `declared=5`), health-check runs green; panel/board loads; Plex answers.
- [ ] **Task 10: Close out** — delete the NAS staging dir after 7 days of green; update `docs/observability.md` (#212's local-path caveat paragraph now obsolete — kubelet stats cover everything); comment + close the tracking issue and #212's gap note with the verification evidence; update memory (`local-path` memories superseded); ADR-0009 gets a one-line "Executed YYYY-MM-DD" postscript.

---

## Self-Review

- Spec coverage: enforcement (Task 3 SC + Task 9 dd-proof), EPHEMERAL cap (Task 2), sizes (Task 4 table), kill local-path (Task 3 default SC + Task 9 "only local-lvm"), etcd-wipe reality (Task 6 runbook + constraints), temporal/HA dump gap (Task 5 Step 2), #212 closure (Task 10). ✓
- Placeholders: none — every script/step names its exact command or file. The one deliberate lookup is Task 2 Step 3 (schema re-check against Talos docs on dry-run rejection), which is a guard, not a gap. ✓
- Name consistency: `local-lvm`, VG `storage`, partition label `storage`, `installLvmLocalPv`, staging dir path — used identically across Tasks 2–10. ✓
