// Pulumi program for the control-center k3s cluster stack (CC-k8t7: migrated to
// SOPS+age secrets). Decrypts secrets/vault.yaml once (via vault.ts) and creates
// native k8s Secrets per workload — no ESO, no 1Password SDK, no in-cluster age
// key. The /run/secrets/<NAME> mount contract in component.ts is unchanged.
//
// Local `pulumi up`: age key from macOS Keychain (zero setup).
// CI deploy: SOPS_AGE_KEY injected from AGE_PRIVATE_KEY GitHub secret.

import * as pulumi from "@pulumi/pulumi";
import { installCertManager, issuePortalCertificate } from "./src/certmanager.ts";
import { makeCluster } from "./src/cluster.ts";
import { installCnpg } from "./src/cnpg.ts";
import { deployCrons } from "./src/crons.ts";
import { installEso } from "./src/eso.ts";
import { verifyLiveGhcrPullSecrets } from "./src/ghcr-pull-secret-preflight.ts";
import { installHomeAssistant } from "./src/homeassistant.ts";
import { installLocalPath } from "./src/local-path.ts";
import { installMetallb } from "./src/metallb.ts";
import { installMetricsServer } from "./src/metrics-server.ts";
import { installNvidiaDevicePlugin, installNvidiaRuntimeClass } from "./src/nvidia.ts";
import {
  deployServices,
  parseSubstrateTarget,
  shouldRequireImageDigestPins,
} from "./src/services.ts";
import { loadVault } from "./src/vault.ts";

const cfg = new pulumi.Config("wwwinfra");
const kubeContext = cfg.get("kubeContext");
const stackName = pulumi.getStack();
// kubeContext selects the target cluster. Default home-server (prod, the Talos
// node reached over the tailnet); a machine-local staging cluster overrides
// it (e.g. `pulumi config set wwwinfra:kubeContext orbstack`). CI points the
// provider at the context name in its own kubeconfig (the home-server
// kube-apiserver over the tailnet).
const cluster = makeCluster(kubeContext);
const namespaces = Object.fromEntries(
  Object.entries(cluster.namespaces).map(([name, namespace]) => [name, namespace.metadata.name]),
) as Record<keyof typeof cluster.namespaces, pulumi.Output<string>>;

// Decrypt vault once; all secrets flow from this (CC-k8t7).
const vault = loadVault();

// Native k8s Secrets per workload from vault (replaces ESO ExternalSecrets).
const eso = installEso({
  provider: cluster.provider,
  namespaces,
  vault,
});

// CNPG operator + product-owned Postgres Clusters with native basic-auth Secrets.
const cnpg = installCnpg({
  provider: cluster.provider,
  namespaces,
  operatorVersion: "1.29.1",
  vault,
});

// Metrics API, so `kubectl top` works. OrbStack's k3s ships without it, which
// left the cluster with zero memory visibility during the 2026-07-24 outage.
installMetricsServer({
  provider: cluster.provider,
  version: "v0.8.0",
});

// cert-manager + CF DNS-01 ClusterIssuer (www-j934.5). No longer issues a
// Certificate directly (SDD track 0, Task 6 removed the app-namespace copy
// along with the captive-portal namespace); issuePortalCertificate() below is
// now the only source of a portal TLS Certificate.
const certManager = installCertManager({
  provider: cluster.provider,
  acmeEmail: cfg.get("acmeEmail"),
  version: "v1.20.2",
  vault,
});

// The portal Certificate, in control-center (Task 4 step B, SDD track 0): the
// guest listener that carries live LAN guest traffic lives in the
// control-center-api workload, and a k8s Secret mount is always
// namespace-local to the pod. This was deliberately ADDITIVE alongside the
// original captive-portal-namespace Certificate during the Task 4 cutover
// (so cert-issuance latency never landed inside the atomic port swap); Task 6
// deleted that original Certificate + its namespace once the cutover was
// live-verified, leaving this as the sole portal Certificate.
const controlCenterGuestCert = issuePortalCertificate({
  provider: cluster.provider,
  namespace: namespaces["control-center"],
  issuer: certManager.issuer,
  resourceName: "control-center-guest-tls",
});

// App workloads (www-j934.6). The media pipeline runs inside the always-on
// worker workload (media-worker was merged into it), so there is no separate
// media replica knob.
// cloudflaredReplicas: 0 for a pre-cutover bring-up so the k3s cloudflared does
// NOT register the live tunnel token alongside Swarm (a prod split-brain); the
// cutover (www-j934.9 / DESIGN §7 step 3) flips it to 2 (HA) as Swarm comes down.
// Drive via `pulumi config set wwwinfra:cloudflaredReplicas 0|2`; default 2.
// nasNfsServer defaults to the NAS LAN IP. The NFS PV is mounted by KUBELET in
// the node netns, which on homelab (the prod target) reaches the home LAN
// directly (DESIGN 5b spike). The pod-egress no-route limitation (DESIGN 5c)
// does NOT apply to PV mounts. Overridable only if a node ever needs a different
// path to the NAS (www-j934.17).
// imageDigests: per-service image digest pins (name -> "sha256:…"). The CI deploy
// job writes these with `pulumi config set --path imageDigests.<svc>` from the
// freshly built :main manifests, so a `pulumi up` rolls only the workloads whose
// digest changed (the www-czg digest-pin guarantee, now config-driven). In prod,
// the program refuses to render app Deployments unless this map is complete.
// Non-prod local applies may omit it and fall back to :main.

// The NAS NFS server, shared by the worker media share and the pg-backup target.
const nasNfsServer = cfg.get("nasNfsServer") ?? "192.168.0.218";
const imageDigests = cfg.getObject<Record<string, string>>("imageDigests") ?? {};

// coldStart: a one-time escape hatch for the FIRST `pulumi up` against a brand
// new, empty cluster (the Talos home-server bring-up, www-j934.9). Two steady-
// state guards both assume the cluster is already seeded and deadlock a cold
// cluster: (1) `verifyLiveGhcrPullSecrets` asserts the ESO-managed `ghcr-pull`
// Secret already exists live — but that Secret is created BY this same apply, so
// on an empty cluster the preflight throws before the apply that would create
// it; (2) the prod digest-pin requirement refuses to render app Deployments
// without a complete `imageDigests` map, but a cold bring-up has no CI-built
// digests yet and just wants the current `:main` images. `coldStart=true`
// relaxes BOTH so a single apply can seed the cluster (namespaces + ghcr-pull +
// local-path/MetalLB/CNPG + workloads on `:main`); the very next steady-state
// deploy (default `coldStart=false`) restores digest pinning + the preflight.
const coldStart = cfg.getBoolean("coldStart") ?? false;

if (!coldStart && Object.keys(imageDigests).length > 0) {
  verifyLiveGhcrPullSecrets({ context: kubeContext });
}

// target: which cluster this program targets. Missing config = "orbstack"
// (the mini), so an untouched stack keeps rendering today's live mini values
// byte-for-byte (haTarget/plexAdvertiseIp in services.ts). The Talos migration
// target is "home-server" node context / "talos" substrate, at the static LAN
// IP below (MetalLB pool 192.168.0.3-192.168.0.4 sits alongside it). A talos
// target's nodeIp is REQUIRED by SubstrateTarget's type (Task 4's deferred
// Task-3 cleanup), so it can never reach a talos code path empty.
// Drive via `pulumi config set wwwinfra:substrate talos` on the talos stack.
const target = parseSubstrateTarget(cfg.get("substrate"), cfg.get("nodeIp"));

const services = deployServices({
  provider: cluster.provider,
  namespaces,
  cloudflaredReplicas: cfg.getNumber("cloudflaredReplicas") ?? 2,
  nasNfsServer,
  requireImageDigestPins: shouldRequireImageDigestPins(stackName) && !coldStart,
  imageDigests,
  target,
  vault,
});

// Scheduled jobs (www-j934.7): portal-data-purge + map-extract re-homed to k8s
// CronJobs, plus product Postgres backups to the NAS. NO docker-image-prune
// (kubelet image GC) and NO portal-cert-renew (cert-manager owns TLS). The
// backup NFS PVs reuse nasNfsServer; the purge job's POSTGRES_PASSWORD comes
// from its ESO Secret (secrets-map.ts), backup creds come from CNPG-managed
// basic-auth Secrets, so order after eso + cnpg.
const crons = deployCrons({
  provider: cluster.provider,
  namespaces,
  nasNfsServer,
  imageDigests,
});

// Task 4 (Talos migration): local-path-provisioner, MetalLB, the `nvidia`
// RuntimeClass, and the Home Assistant workload + its dedicated CNPG cluster
// + backup crons. ALL gated behind `target.substrate === "talos"` , on
// "orbstack" (the default, and every stack today) this whole block does not
// run, so the mini's live deploy adds ZERO new resources from this task.
// Talos node context IS the k3s "orbstack" equivalent here: the mini needs
// neither a storage provisioner (OrbStack ships one) nor a LoadBalancer
// implementation (OrbStack's expose_services), and has no GPU passthrough.
if (target.substrate === "talos") {
  installLocalPath({ provider: cluster.provider, version: "v0.0.31" });
  installMetallb({ provider: cluster.provider, version: "v0.14.9" });
  installNvidiaRuntimeClass({ provider: cluster.provider });
  // The device plugin advertises nvidia.com/gpu so GPU workloads (Plex) can be
  // scheduled; needs the nvidia kernel modules (infra/talos machine.kernel).
  installNvidiaDevicePlugin({ provider: cluster.provider });
  installHomeAssistant({
    provider: cluster.provider,
    // Reuses the ALREADY-installed CNPG operator (cnpg.ts's installCnpg()
    // above): its CRDs/webhooks are cluster-scoped singletons, so
    // home_assistant's Cluster only needs to depend on that install having
    // finished, never a second operator install.
    cnpgOperator: cnpg.operator,
    vault,
    nasNfsServer,
  });
}

// Surface resource names (not values) for the Phase-3 acceptance checks.
export const externalSecretNames = eso.externalSecrets.map((e) => e.metadata.name);
export const namespaceNames = Object.fromEntries(
  Object.entries(cluster.namespaces).map(([name, namespace]) => [name, namespace.metadata.name]),
);
export const appNamespaceName = cluster.namespaces["control-center"].metadata.name;
export const cnpgClusterName = cnpg.cluster.metadata.name;
export const cnpgClusterNames = cnpg.clusters.map((c) => c.metadata.name);
export const controlCenterGuestCertName = controlCenterGuestCert.metadata.name;
export const cnpgAuthSecretNames = cnpg.authSecrets.map((s) => s.metadata.name);
export const workloadNames = services.workloads.map((w) => w.deployment.metadata.name);
export const cronJobNames = crons.jobs.map((j) => j.cronJob.metadata.name);
