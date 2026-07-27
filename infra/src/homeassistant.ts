// Home Assistant on Talos (Task 4, Talos migration §0.1-§0.4): a self-
// contained "home-assistant" namespace (L1: NOT in cluster.ts's closed
// InfraNamespaceName map , this module creates it directly) holding:
//   1. its OWN single-instance CNPG `Cluster` (db `home_assistant`), NOT a
//      second database bolted onto control-center-1 (§0.1: HA's recorder
//      writes constantly and purges aggressively , sharing an instance with
//      control-center risks noisy-neighbor lock contention on a disposable
//      dataset). No history is migrated from the mini's SQLite recorder.
//   2. the `ha-config` PVC (local-lvm, 5Gi , §0.3: holds ONLY `.storage` +
//      top-level YAML, seeded from a stopped-HA snapshot at cutover, Task 11;
//      the recorder does NOT live here).
//   3. the HA Deployment itself: hostNetwork (Talos has no tailnet-routed
//      socat equivalent to reach a non-hostNetwork pod's :8123 the way the
//      mini does, see services.ts's haTarget), no Supervisor (this is HA
//      Core in a plain container, not HAOS).
//
// §0.4: nothing here touches the `control-center` namespace , the `ha`
// ExternalName Service in services.ts is the ONLY cross-namespace pointer,
// and it already exists (Task 3's haTarget), unchanged by this file.
//
// TALOS-ONLY: the whole module is a no-op unless installHomeAssistant() is
// called, which program.ts only does behind `substrate === "talos"`.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ScheduledJob, Workload } from "./component.ts";
import { haConfigBackupCronSpec, homeAssistantPgBackupCronSpec } from "./crons.ts";

export const HOME_ASSISTANT_NAMESPACE = "home-assistant";

const CNPG_CLUSTER_NAME = "home-assistant-postgres";
const CNPG_AUTH_SECRET_NAME = "home-assistant-postgres-auth";
// Exported: Task 11's cutover script composes the recorder `db_url` from
// these three plus the HOME_ASSISTANT_POSTGRES__PASSWORD vault key (see the
// Workload's env comment below for why that composition can't happen here).
export const DATABASE_NAME = "home_assistant";
// Single admin role for both bootstrap ownership and CNPG's superuserAccess ,
// same simplified bridge cnpg.ts uses for control-center (one basic-auth
// Secret serves both purposes, see cnpg.ts's header comment).
export const DATABASE_OWNER = "postgres";
export const CNPG_RW_SERVICE_NAME = `${CNPG_CLUSTER_NAME}-rw`;

const HA_CONFIG_CLAIM_NAME = "ha-config";
// §0.3: small on purpose , .storage + YAML only, NOT recorder history (that's
// the CNPG cluster above). 5Gi is generous headroom over the actual (few-MB)
// footprint of those files.
const HA_CONFIG_CLAIM_SIZE = "5Gi";

// §0.2: aggressive purge , a few days, not HA's 10-day default, since this is
// the *entire* retention window Task 4 is deliberately choosing for the
// Postgres recorder (no separate archival tier exists yet). Exported (not
// just a comment) so Task 11's cutover script writes the SAME number into
// configuration.yaml's `recorder: purge_keep_days:` , a single source, not a
// value that can silently drift between this file and that one.
export const RECORDER_PURGE_KEEP_DAYS = 3;

export interface HomeAssistantArgs {
  provider: k8s.Provider;
  // The already-installed CNPG operator (cnpg.ts's installCnpg().operator),
  // so this NEVER re-installs the operator's cluster-scoped CRDs/webhooks ,
  // those are singletons, shared across every CNPG Cluster in the stack
  // (control-center's and this one).
  cnpgOperator: k8s.yaml.ConfigFile;
  // Decrypted vault (vault.ts, CC-k8t7). Needs HOME_ASSISTANT_POSTGRES__PASSWORD.
  vault: Record<string, string>;
  // NAS NFS server for the ha-config + home_assistant-postgres backup crons
  // (same knob services.ts/crons.ts thread through for every other backup).
  nasNfsServer: string;
}

export interface HomeAssistantResources {
  namespace: k8s.core.v1.Namespace;
  authSecret: k8s.core.v1.Secret;
  cluster: k8s.apiextensions.CustomResource;
  configClaim: k8s.core.v1.PersistentVolumeClaim;
  workload: Workload;
  backupJobs: ScheduledJob[];
}

function createAuthSecret(
  vault: Record<string, string>,
  namespace: pulumi.Input<string>,
  opts: pulumi.CustomResourceOptions,
): k8s.core.v1.Secret {
  const password = vault.HOME_ASSISTANT_POSTGRES__PASSWORD;
  if (password === undefined) {
    throw new Error("homeassistant: vault key HOME_ASSISTANT_POSTGRES__PASSWORD not found");
  }
  return new k8s.core.v1.Secret(
    CNPG_AUTH_SECRET_NAME,
    {
      metadata: { name: CNPG_AUTH_SECRET_NAME, namespace },
      type: "kubernetes.io/basic-auth",
      stringData: { username: DATABASE_OWNER, password: pulumi.secret(password) },
    },
    opts,
  );
}

function createCluster(
  namespace: pulumi.Input<string>,
  cnpgOperator: k8s.yaml.ConfigFile,
  authSecret: k8s.core.v1.Secret,
  opts: pulumi.CustomResourceOptions,
): k8s.apiextensions.CustomResource {
  return new k8s.apiextensions.CustomResource(
    CNPG_CLUSTER_NAME,
    {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: { name: CNPG_CLUSTER_NAME, namespace },
      spec: {
        instances: 1,
        enableSuperuserAccess: true,
        superuserSecret: { name: CNPG_AUTH_SECRET_NAME },
        bootstrap: {
          initdb: {
            database: DATABASE_NAME,
            owner: DATABASE_OWNER,
            secret: { name: CNPG_AUTH_SECRET_NAME },
          },
        },
        // Disposable recorder data (§0.1: no history migrated) still needs to
        // survive routine restarts, so it's still a real PVC , just not
        // backed up as carefully as control-center's (the aggressive purge
        // means there's rarely more than RECORDER_PURGE_KEEP_DAYS of data to
        // lose anyway).
        storage: { storageClass: "local-lvm", size: "5Gi" },
        resources: {
          limits: { memory: "512Mi" },
          requests: { cpu: "250m", memory: "256Mi" },
        },
      },
    },
    { ...opts, dependsOn: [cnpgOperator, authSecret] },
  );
}

/**
 * @public - installs the home-assistant namespace, its dedicated CNPG
 * cluster, the ha-config PVC, the HA Deployment, and its two backup crons.
 * Consumed by program.ts, gated to the "talos" substrate.
 */
export function installHomeAssistant(args: HomeAssistantArgs): HomeAssistantResources {
  const { provider, cnpgOperator, vault, nasNfsServer } = args;
  const opts = { provider };

  const namespace = new k8s.core.v1.Namespace(
    HOME_ASSISTANT_NAMESPACE,
    {
      metadata: {
        name: HOME_ASSISTANT_NAMESPACE,
        // Pod Security "privileged": HA runs hostNetwork (binds :8123 in the
        // node netns for mDNS/HomeKit/Thread/ESPHome discovery, see the
        // Workload below), which the cluster-default `baseline` PSA forbids —
        // an unlabeled namespace leaves the HA pod FORBIDDEN at admission.
        // This dedicated namespace holds only HA + its own CNPG Postgres, so
        // scoping it privileged is contained (codified from the 2026-07-24
        // cutover, where this was a live `kubectl label` emergency patch).
        labels: { "pod-security.kubernetes.io/enforce": "privileged" },
      },
    },
    opts,
  );
  const namespaceName = namespace.metadata.name;

  const authSecret = createAuthSecret(vault, namespaceName, { ...opts, dependsOn: [namespace] });
  const cluster = createCluster(namespaceName, cnpgOperator, authSecret, {
    ...opts,
    dependsOn: [namespace],
  });

  const configClaim = new k8s.core.v1.PersistentVolumeClaim(
    HA_CONFIG_CLAIM_NAME,
    {
      metadata: { name: HA_CONFIG_CLAIM_NAME, namespace: namespaceName },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: "local-lvm",
        resources: { requests: { storage: HA_CONFIG_CLAIM_SIZE } },
      },
    },
    { ...opts, dependsOn: [namespace] },
  );

  // Home Assistant reads its recorder config from configuration.yaml, NOT env
  // vars , there is no in-cluster mechanism to hand it a `postgresql://`
  // URL directly, so this deliberately does NOT compose or inject one via the
  // Workload's env (that would put the CNPG password in the plain (non-
  // Secret) Deployment env, which component.ts's env field renders as
  // cleartext, not a Secret , a secrets-hygiene regression). Task 11's
  // cutover script instead composes it from these exported constants
  // (CNPG_RW_SERVICE_NAME, DATABASE_NAME, DATABASE_OWNER) plus the
  // HOME_ASSISTANT_POSTGRES__PASSWORD vault key, and writes the resulting
  // `recorder: db_url: postgresql://...` + `purge_keep_days:
  // RECORDER_PURGE_KEEP_DAYS` block directly into the seeded `.storage`+YAML
  // PVC content at cutover , not here.

  const workload = new Workload(
    {
      logicalName: "home-assistant",
      name: "home-assistant",
      namespace: namespaceName,
      provider,
      image: "ghcr.io/home-assistant/home-assistant:stable",
      replicas: 1,
      // NO gpu / runtimeClassName: HA Core delegates camera/media work to its
      // integrations (go2rtc, upstream services), not a local CUDA transcode,
      // so it needs no GPU. The earlier `gpu: 1` + `nvidia` RuntimeClass were a
      // copy-paste from the Plex workload (services.ts) and, with the node's
      // NVIDIA device plugin still deferred, left the pod Pending "Insufficient
      // nvidia.com/gpu" for its whole life — codified removal from the
      // 2026-07-24 cutover live-patch.
      resources: {
        memory: "1G",
        reserveCpus: "0.5",
      },
      // hostNetwork: HA binds :8123 in the NODE's netns so other pods (and
      // the `ha` ExternalName in services.ts) reach it at the node LAN IP,
      // mirroring how the mini's HA is reached via its host's tailnet
      // socat , see haTarget()'s comment in services.ts. dnsPolicy MUST
      // accompany hostNetwork or the pod loses in-cluster DNS.
      hostNetwork: true,
      dnsPolicy: "ClusterFirstWithHostNet",
      env: {
        TZ: "America/Los_Angeles",
      },
      volumes: [{ mountPath: "/config", claim: HA_CONFIG_CLAIM_NAME }],
      // No `ports`: hostNetwork pods don't need a k8s Service to be reached
      // at :8123 (services.ts's `ha` ExternalName points straight at the
      // node LAN IP, not at a Service backed by this Deployment's pod).
    },
    { ...opts, dependsOn: [configClaim] },
  );

  const backupJobs = [
    new ScheduledJob(
      {
        ...haConfigBackupCronSpec({ nasNfsServer, haConfigClaimName: HA_CONFIG_CLAIM_NAME }),
        provider,
        namespace: namespaceName,
      },
      { ...opts, dependsOn: [configClaim] },
    ),
    new ScheduledJob(
      {
        ...homeAssistantPgBackupCronSpec({
          nasNfsServer,
          serviceHost: CNPG_RW_SERVICE_NAME,
          databaseName: DATABASE_NAME,
          owner: DATABASE_OWNER,
          authSecretName: CNPG_AUTH_SECRET_NAME,
        }),
        provider,
        namespace: namespaceName,
      },
      { ...opts, dependsOn: [cluster] },
    ),
  ];

  return { namespace, authSecret, cluster, configClaim, workload, backupJobs };
}
