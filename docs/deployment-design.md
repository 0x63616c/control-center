# Control-Center Deployment Design

Status: **CURRENT** (www-j934) · Scope: how control-center is built, deployed, and kept
alive on `homelab` (the Mac Mini).

> **History.** This repo previously deployed through `bosun`, an in-repo tool that rendered
> `deploy.config.ts` to a Docker Swarm stack on OrbStack, with a `bosun-agent` webhook that CI
> POSTed a digest map to. That whole layer (`packages/bosun`, `deploy.config.ts`, the
> `bosun-agent`, the `refs/deploy/main` marker, `deploy-drift.yml`) has been removed. Deploy is
> now **Pulumi + Kubernetes**. The deep design lives in
> [`k3s-migration/DESIGN.md`](./k3s-migration/DESIGN.md); this file is the operator-facing
> overview plus the hard-won recovery knobs.

---

## 1. Plain English (read this first)

`infra/` is a **Pulumi TypeScript** program that declares the whole cluster, and a service is
still declared in one typed place (a `ComponentResource` vocabulary succeeds bosun's
`service()` / `cronJob()` builders). `pulumi up --stack prod` reconciles the OrbStack built-in
**Kubernetes** cluster on `homelab` to match it. State lives in **Pulumi Cloud** (Calum's
personal account; token from SOPS vault `PULUMI_ACCESS_TOKEN__TOKEN`).

When you push to `main`: **GitHub Actions builds the changed images** (off the Mini), pushes
them to GHCR, then the deploy job **joins the tailnet on an ephemeral `tag:ci` auth key** (so
the runner can reach homelab's kube-apiserver), sets the per-image digests as Pulumi config,
and runs `pulumi up --stack prod`. Only the workloads whose digest changed roll. The ephemeral
node is revoked after the deploy.

Cluster-level machinery, all declared in `infra/` and reconciled by the same `pulumi up`:

- **Namespaces:** product workloads live in product-owned namespaces,
  `control-center` and `captive-portal`. Shared edge runtime lives in
  `platform`, currently the in-cluster `cloudflared` Deployment and tunnel-token Secret. Names
  inside a namespace stay local (`api`, `web`, `frontend`, `app`); Pulumi logical names and other
  global names use full product slugs (`control-center-api`, `captive-portal-api`). DNS remains the
  exception: flattened hostnames use each product's `dnsCode`, for example `app--cc`.

- **SOPS+age vault secrets**: `loadVault()` in `infra/src/vault.ts` decrypts `secrets/vault.yaml`
  at Pulumi deploy time and creates native k8s `Secret`s per workload; pods mount them at
  `/run/secrets/<NAME>` paths unchanged. No ESO operator; no 1Password API calls at deploy
  time (1Password is cold-backup only, CC-k8t7).
- **cert-manager** with a Cloudflare **DNS-01** ClusterIssuer issues/renews the captive-portal
  TLS cert (the portal is LAN-only, HTTP-01 can't reach it).
- **CloudNativePG (CNPG)** runs Postgres as a single-instance `Cluster` on a local-path PVC on
  the SSD (not NFS).
- **cloudflared** runs **in-cluster** in the `platform` namespace as a Deployment with **2 replicas** (HA, never an HPA) and
  owns the public `*.worldwidewebb.co` routing; tunnel ingress is declared in the Pulumi
  cloudflare provider. Because cloudflared is outside the product namespaces, origins must use
  namespace-qualified Kubernetes service DNS such as `web.control-center.svc.cluster.local`, never
  product-local names like `web`. Control Center's wall panel is served at the **private** route
  `app--cc.worldwidewebb.co` behind a Cloudflare **Access** kiosk service-token policy (a
  default-deny `*.worldwidewebb.co` floor sits under it). `/trpc` is same-origin behind that
  host, so there is **no external `api.cc` route** (the api is an internal-only service). The
  legacy public host `dashboard.worldwidewebb.co` stays live as temporary compatibility until the
  iOS/wall-panel cutover is verified, then retired per
  `docs/k3s-migration/cc-legacy-route-retirement.md` (www-jtp0.7).

Three things stay on the host by hand (manual runtime): Tailscale, the Home Assistant VM, and
OrbStack.

---

## 2. Architecture overview

```
┌─ HOST INFRA (manual runtime; plists managed by Pulumi command.remote) ──────────────┐
│  Tailscale daemon · HA QEMU VM @ :8123 + socat proxy · unifi socat :8444            │
│  homelab-drive NFS mount · orbstack-watchdog · k8s-apiserver-forward socat          │
├─ RUNTIME (one dep, start-at-login) ─────────────────────────────────────────────────┤
│  OrbStack → built-in single-node Kubernetes (kubelet image GC)                      │
│   └ "Expose services to local network devices" ON (LAN reach for the portal)        │
├─ CLUSTER (declared in infra/, applied by `pulumi up --stack prod`) ─────────────────┤
│  SOPS+age loadVault() (infra/src/vault.ts)         → native k8s Secrets              │
│  cert-manager + CF DNS-01 ClusterIssuer            → portal TLS Certificate         │
│  cnpg operator → product Clusters in product namespaces (local SSD PVCs)            │
│  platform namespace → cloudflared Deployment ×2 (HA, never autoscale)               │
│  product namespaces → local Deployments: api · web · worker · frontend · app        │
│  product namespaces → owner CronJobs: pg-backup · captive-portal-pg-backup          │
├─ EXTERNAL STATE (Pulumi providers, Pulumi Cloud backend) ───────────────────────────┤
│  cloudflare: Access apps/policies + tunnel ingress   · unifi: adopt-only import     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Full per-service / per-cron mapping, secrets, data-migration runbook, the pod→host egress
solution, captive-portal LAN exposure, and the UniFi import plan are all in
[`k3s-migration/DESIGN.md`](./k3s-migration/DESIGN.md).

---

## 3. Deploy path (push → live)

```
push to main
  → changes  (dorny/paths-filter; per-app filters + an `infra/**` filter)
  → test-unit      (biome · guards · vitest jsdom)         ─┐
  → test-storybook (vitest chromium via Playwright)         ├─ gate deploy, run concurrently
  → typecheck      (tsc · knip)                            ─┘   with the build jobs below
  → build-{web,api,worker,storybook,drizzle,captive-portal,captive-portal-api,map-provision}  (arm64 → GHCR :sha + :main)
    (start right after `changes`, do NOT queue behind the test gates)
  → deploy:
       - collect per-image :main digests (buildx imagetools inspect)
       - join the tailnet with an EPHEMERAL Tailscale auth key (tag:ci), reach homelab's apiserver
       - `pulumi login` (Pulumi Cloud; token from SOPS vault via `prod` environment)
       - `pulumi config set --path` the per-image digest map (see the namespace note below)
       - `pulumi up --yes --stack prod`  → only services whose digest changed roll
       - revoke/expire the ephemeral key; leave the tailnet
```

**Digest pinning** is preserved as Pulumi stack config: a changed digest changes the rendered
Deployment image, so only that workload's pods roll, the same property as the old
`docker stack deploy` digest pin, without bosun. Image repos use full product slugs outside DNS,
for example `www-control-center-api`, `www-captive-portal-portal`,
and `www-captive-portal-api`. Digest keys match the product-component name, for
example `wwwinfra:imageDigests.control-center-api` and
`wwwinfra:imageDigests.captive-portal-api`. `pulumi up` is
**declarative-convergent** (it reconciles the whole declared stack to the latest committed
digests every green run), so the old `refs/deploy/main` marker, `mark-deployed`, and
`deploy-drift.yml` are gone, the latest run always converges prod to `main`.

Forced full redeploy: `gh workflow run ci.yml --ref main` (rebuilds + redeploys everything).

---

## 4. Scheduling

Cron jobs are **Kubernetes `CronJob`s declared in `infra/src/crons.ts`**, NOT bosun
`cronJob()` and NOT a third-party scheduler. They run on `TZ=America/Los_Angeles` (set as a pod
env), so a `0 3 * * *` schedule fires at 03:00 LA. Today: `portal-data-purge` (nightly DB
cleanup against the compatibility Control Center database), `pg-backup` (Control Center nightly
logical backup to the unchanged compatibility NAS path), `captive-portal-pg-backup` (Captive
Portal nightly logical backup to its product NAS path), `map-extract` (monthly basemap refresh,
www-hn1i, runs the `map-provision` image in force mode; the build date is resolved at runtime
because Protomaps deletes daily builds after ~7 days, so a pinned date rots). The old
`docker-image-prune` cron is gone, kubelet image GC replaces it.

**Basemap self-provisioning (www-hn1i):** the web Deployment carries a `map-provision`
initContainer (same image, if-missing mode) so a fresh stack extracts `socal.pmtiles` into the
`maps` PVC before nginx ever serves, no manual provisioning step exists. Ad-hoc refresh:
`kubectl create job --from=cronjob/map-extract <name> -n control-center`. nginx serves
`/maps/` with a real 404 on a missing file (no SPA fallback), so a provisioning failure is
loud. Hermetic tests: `scripts/test-map-provision.sh` (also a CI `test`-job gate).

---

## 5. Persistence & restart survival

```
login → OrbStack starts at login → built-in Kubernetes restarts → pods Running (etcd state)
       → local-path PVCs intact (CNPG pgdata, drizzle-data, maps) → in-cluster cloudflared
         reconnects the tunnel → live
```

OrbStack autostart is **login-scoped** (auto-login + start-at-login), the same persistence
anchor as the Swarm era, NOT a boot daemon. The reboot acceptance test is: restart OrbStack (or
reboot the mini) and confirm the node comes back on login with `kubectl get pods -A` all
Running unattended and `https://dashboard.worldwidewebb.co` returning 200. The host launchd
runtimes below keep running throughout.

---

## 6. Recovery: hard-won operational knobs

These are the load-bearing host/cluster settings discovered during the migration. A future
session bringing the box back up, or debugging an OOM-loop / unreachable apiserver, needs them.

**OrbStack VM memory: `memory_mib=6144`.** Set via `orbctl config set k8s.memory_mib=6144` (or
the equivalent VM-memory knob). **5120 was too small**, the k8s control plane OOM-loops and the
cluster never settles. 6144 is the proven floor on the 8GB mini.

**Home Assistant VM: `-m 2G` in `~/homeassistant-os/start-haos.sh`.** The HAOS QEMU VM needs 2G.
That start script ALSO needs `export PATH=/opt/homebrew/bin` near the top, so launchd can exec
`qemu` on reboot (launchd's minimal PATH doesn't include Homebrew, so without it the VM silently
fails to start after a reboot).

**`com.calum.k8s-apiserver-forward` launchd socat job.** Forwards `127.0.0.1:26443` →
the OrbStack VM node IP `192.168.139.2:26443`. OrbStack does **not** always rebind the host
loopback to the apiserver after a restart, so without this job `kubectl` (and `pulumi up`)
against the loopback context can fail post-reboot. The job is `KeepAlive` so it self-restores.

**`com.calum.portal-443-forward` root LaunchDaemon (www-j934.20) — historical, retired.**
Forwarded the mini's LAN en1 `192.168.0.147:443` → the k8s captive-portal LB
`192.168.139.2:443`, so `https://app--cp.worldwidewebb.co` and the legacy
`https://captive-portal.worldwidewebb.co` were reachable on the LAN with the cert-manager cert.
OrbStack `expose_services` republished the portal LB's `:80` onto en1 but NOT `:443`: OrbStack's
own built-in HTTPS proxy (`network.https: true`, serving `*.orb.local`) already held the
wildcard host `:443`, so `expose_services` only landed `:443` on a random NodePort. This raw-TCP
passthrough (the portal terminated its own TLS) was the surgical, restart-free fix. It was a
**system** LaunchDaemon, not a user LaunchAgent, because `:443` is privileged. Both the mini and
the `captive-portal` product it served are gone (mini retired 2026-07-25; captive-portal
dissolved into the single-product repo, ADR-0006); `products/captive-portal/` no longer exists
and `scripts/portal-443-forward.sh` was deleted as dead code in #140. Kept here as a historical
record only, not a live runbook.

**ESO removed (CC-k8t7).** The external-secrets operator and 1Password SDK provider have been
removed from the cluster. Secrets now flow from `secrets/vault.yaml` via `loadVault()` at
Pulumi deploy time. The `256Mi` ESO memory limit note is obsolete.

**`cloudflaredReplicas=2`, committed in `infra/Pulumi.prod.yaml`.** The in-cluster cloudflared
runs 2 replicas for tunnel HA. This is a committed stack-config value, not a code default;
keep it at 2 (HA only, never an HPA).

**`wwwinfra:imageDigests` namespace requirement.** The CI deploy job MUST set the per-image
digest map WITH the `wwwinfra:` config namespace prefix, i.e.
`pulumi config set --path wwwinfra:imageDigests.<svc> <digest>`. **If the `wwwinfra:` prefix is
omitted, the value lands in the wrong (default `pulumi`/project) namespace, `infra/` never reads
it, and builds silently never roll** (the deploy "succeeds" but pods stay on the old digest).
The program reads `new Config("wwwinfra").getObject("imageDigests")`; the key must match.
This is the single most important deploy invariant to get right.

**Local prod deploy digest safety (www-z8mv).** The `prod` Pulumi stack refuses to render app
Deployments unless every app image has a `wwwinfra:imageDigests.<product-component>` pin. This
prevents a local `pulumi up --stack prod` with an empty or mis-namespaced digest map from replacing
pods with mutable private `:main` images, which can ImagePullBackOff on homelab. The CI deploy path
collects every current GHCR `:main` manifest digest, clears the old map, writes the complete
`wwwinfra:imageDigests` map, then runs `pulumi up`, so normal main deploys still converge. For local
prod repair, first set the same digest map, or run a non-prod stack if you intentionally want `:main`.

**GHCR pull secret preflight (www-n32z).** When CI supplies image digests, the Pulumi program runs a
live preflight before rendering workloads. It asserts that `ghcr-pull` exists as a
`kubernetes.io/dockerconfigjson` Secret with `.dockerconfigjson` data in every namespace that
declares private GHCR workloads: `control-center` and `captive-portal`.
This catches Pulumi-state drift where the Secret is missing from the live cluster but still present
in state before kubelet starts pulling anonymously and throwing `ImagePullBackOff` / `unauthorized`.
You can run the same check manually with `bun run --filter @www/infra verify:ghcr-pull-secrets`.
Recovery is a targeted refresh and up for the missing Secret, then rerun the deploy:

```bash
cd infra
pulumi login
pulumi stack select prod
pulumi refresh --yes --stack prod --target urn:pulumi:prod::world-wide-webb::kubernetes:core/v1:Secret::<namespace>-ghcr-pull
pulumi up --yes --stack prod --target urn:pulumi:prod::world-wide-webb::kubernetes:core/v1:Secret::<namespace>-ghcr-pull
bun run --filter @www/infra verify:ghcr-pull-secrets
```

Replace `<namespace>` with the failing namespace, for example `control-center`. If more than one
namespace is missing, repeat the two targeted Pulumi commands for each failing Secret, or run a full
`pulumi refresh` followed by `pulumi up` when Calum approves broader reconciliation.

**Postgres backup status and restore proof (www-jtp0.2).** The live backup CronJob is
`pg-backup` in namespace `control-center`, derived from the platform `DatabaseBackup` primitive
while preserving the compatibility path `backups/postgres`. Operator commands:

```bash
kubectl --context cc-homelab -n control-center get cronjob pg-backup -o wide
kubectl --context cc-homelab -n control-center create job --from=cronjob/pg-backup pg-backup-manual-$(date +%Y%m%d%H%M%S)
kubectl --context cc-homelab -n control-center wait --for=condition=complete --timeout=180s job/<job-name>
kubectl --context cc-homelab -n control-center logs job/<job-name>
```

Manual backup proof from M2: job `pg-backup-manual-20260613164659` completed `1/1` in 5s and
wrote `/backup/control_center-20260613.sql.gz`; the NAS-backed compatibility path contained
`control_center-20260613.sql.gz` at `4284983` bytes. Dump/restore proof uses the private local
directory `/Users/calum/control-center-pg-snapshots/www-jtp0.2.5-20260613-171514` and the additive
tool:

```bash
scripts/pg-snapshot-restore.sh --dry-run --source production --scratch <scratch-cluster>
scripts/pg-snapshot-restore.sh --source production --scratch <scratch-cluster> --output-dir <private-dir>
scripts/pg-snapshot-restore.sh --compare-counts <source.tsv> <scratch.tsv>
```

Rollback artifacts are the live production database, the nightly NAS backups, and the private
snapshot directory. Human review is required before production dump capture, final snapshots,
non-scratch restores, backup path changes, or destructive cleanup. Scratch restore validation
must delete only scratch resources after evidence is recorded.

**M7 production data cutover (www-jtp0.7.7).** Moving live Control Center data into the product
CNPG cluster follows `docs/k3s-migration/cc-cutover-runbook.md`, which layers M7 safety gates on
top of the row-count tool above: `scripts/cc-cutover-semantic-checks.sql` runs IDENTICALLY on the
source and the restored DB (then diffed) to prove `device_state`/`integration_sync_status`/weather/
`lamp_mode`/media/`job` survived intact (counts alone don't prove semantics);
`scripts/cc-cutover-preflight.sh` is a red-first gate that refuses the cutover until the rehearsal
report (`cc-restore-rehearsal-report.md`), final snapshots, recorded counts, a named rollback
target, and explicit approval are all present; `scripts/cc-post-cutover-smoke.sh` (www-jtp0.7.9)
proves the stack came back healthy; and `scripts/verify-wall-panel.mjs` (www-jtp0.7.10) verifies
the panel at exactly 1366×1024 on `app--cc`. `POSTGRES_HOST` is already `control-center-rw`, so for
prod the cutover is a DATA move, not a code change.

**Captive Portal product database cutover (www-jtp0.5.5, www-0y64.4).** The Captive Portal has its
own product CNPG database declaration for app database `captive_portal`. Its current DB is the
namespace-local `Cluster/postgres` with Services `postgres-rw` / `postgres-ro` / `postgres-r` and
auth Secret `postgres-auth`; the old `Cluster/captive-portal`, `captive-portal-rw` Service, auth
Secret `captive-portal-postgres-auth`, and PVC stay retained for rollback through the soak window.
The frontend Deployment proxies portal-only tRPC traffic to the product API Service
`api.captive-portal.svc.cluster.local:4211`; the API Deployment runs with `POSTGRES_HOST=postgres-rw`
and explicitly declares only the secrets it can read: `POSTGRES_PASSWORD`, `UNIFI_API_KEY`,
`WIFI_PASSWORD`, and `WIFI_SSID`. The nightly backup CronJob is `captive-portal-pg-backup`; it runs at
`15 1 * * *`, uses the same PG 18 dump image as the CNPG server, reads the password from mounted
`postgres-auth`, and writes dated `captive_portal-YYYYMMDD.sql.gz` artifacts under
`backups/world-wide-webb/captive-portal/postgres` on the NAS. Control Center remains unchanged:
`pg-backup` still writes `control_center-YYYYMMDD.sql.gz` to `backups/postgres`.

Captive Portal restore validation uses the same additive proof tool as Control Center. Before any
production database apply that captures or restores portal data, stop for human review and record
the approved source, scratch cluster, and output directory. Then run:

```bash
scripts/pg-snapshot-restore.sh --dry-run --source production --scratch <scratch-cluster>
scripts/pg-snapshot-restore.sh --source production --scratch <scratch-cluster> --output-dir <private-dir>
scripts/pg-snapshot-restore.sh --compare-counts <source.tsv> <scratch.tsv>
```

Rollback note: this cutover must leave the old Control Center portal tables and retained legacy
`captive-portal` CNPG cluster untouched. If the Captive Portal database, auth Secret, service
discovery, API Deployment, proxy path, or backup job fails, roll the portal frontend proxy back to
the Control Center API path or point consumers at the retained legacy database service until restore
validation passes.

**Product CNPG local-name migrations (www-0y64.2).** When normalizing a product database from a
product-slug CNPG Cluster name to the local name `postgres`, do **not** rename the live Cluster in
place. Create the new `postgres` Cluster alongside the old product-slug Cluster, quiesce writers,
dump from the old Cluster, restore into the new Cluster, compare row counts, diff schema-only dumps,
switch consumers by changing `POSTGRES_HOST` to `postgres-rw`, run smoke checks, then keep the old
Cluster/PVCs through a recorded soak window. Rollback before cleanup is always: set `POSTGRES_HOST`
back to the old `*-rw` Service and restart consumers. Destructive cleanup is gated by
`scripts/cnpg-local-name-preflight.sh`, which refuses to go green unless the evidence directory has
matching `source-counts.tsv` / `target-counts.tsv`, an empty `schema.diff`, passing `smoke.txt`, a
`SOAK COMPLETE` record in `soak.txt`, and `CNPG_CLEANUP_APPROVED=yes`. Full operator sequence lives
in `docs/k3s-migration/DESIGN.md` §4.1.

---

## 7. Acceptance criteria

The migration acceptance lives in [`k3s-migration/GOAL.md`](./k3s-migration/GOAL.md) (the goal
contract, phased) and the per-phase AC on the www-j934 child tickets. The legacy
bosun-era checklist (`docs/acceptance-checklist.md`) is retained only as a historical record of
the original Swarm build.
