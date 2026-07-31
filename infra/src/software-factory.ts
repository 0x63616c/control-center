// The `software-factory` k8s namespace and its workloads (ADR-0011): the Go
// Temporal worker that works GitHub tickets, its private API and console, and
// the per-ticket sandboxes the worker creates for agent-authored code.
//
// The shared cluster namespace map creates this namespace because the factory
// now owns a CNPG Cluster and nightly database backup. This installer owns the
// namespace-local worker, API, console, and sandbox isolation boundary.
//
// Why its own namespace at all, rather than running in `control-center`: the
// sandbox executes code an agent wrote. That boundary wants its own RBAC,
// quotas and network policy, and it wants them somewhere a mistake cannot reach
// the house's own workloads. Same reasoning as its separate Temporal namespace.
//
// TALOS-ONLY: a no-op unless installSoftwareFactory() is called, which
// program.ts only does behind `substrate === "talos"`.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { controlCenterProductManifest, softwareFactoryProductManifest } from "@www/platform";
import { DEFAULT_METRICS_PORT, METRICS_PATH } from "@www/platform/metrics/port";
import { GHCR_PULL_SECRET_NAME } from "./ghcr-pull-secrets.ts";
import {
  assertImageDigestPins,
  composeGhcrDockerConfigJson,
  ghcrImage,
  type ImageDigests,
} from "./services.ts";
import {
  DATABASE_PORT,
  SOFTWARE_FACTORY_TEMPORAL_NAMESPACE,
  TEMPORAL_FRONTEND_CLUSTER_ADDRESS,
} from "./temporal.ts";

// The factory's own CNPG database (#540, infra/src/cnpg.ts), read here rather
// than re-declared: one manifest, one set of names, whichever installer needs
// them. The worker connects same-namespace, so its rw Service resolves by its
// bare name — no cross-namespace FQDN needed, unlike temporal-worker's
// cross-namespace reach into control-center's Postgres.
const softwareFactoryDatabase = softwareFactoryProductManifest().database;

/**
 * The k8s namespace the software factory's workloads live in. Deliberately the
 * same string as {@link import("./temporal.ts").SOFTWARE_FACTORY_TEMPORAL_NAMESPACE}:
 * one name for the isolation boundary, whichever kind of namespace is meant.
 */
export const SOFTWARE_FACTORY_NAMESPACE = "software-factory";

/**
 * The ServiceAccount the worker runs as, and the ONLY workload in this cluster
 * that mounts a token at all — every other Deployment sets
 * `automountServiceAccountToken: false` deliberately, and sandboxes continue to
 * (podspec.go).
 */
const WORKER_SERVICE_ACCOUNT = "software-factory-worker";

/**
 * The codex credential Secret. Pulumi does NOT own its contents: the OAuth
 * refresh token rotates on first use, so a value in the SOPS vault is dead
 * within a day and a later `pulumi up` recreating the Secret would seed a
 * corpse. scripts/seed-codex-auth.sh applies it out of band (#344).
 *
 * The name is here because the Role below pins to it by `resourceNames`, and a
 * second spelling of it would be a grant that silently covers nothing.
 */
const CODEX_AUTH_SECRET_NAME = "codex-auth";

/** The worker's own config Secret: the GitHub App credential set. */
const WORKER_SECRET_NAME = "software-factory-worker-secrets";
const API_SECRET_NAME = "software-factory-api-secrets";
const API_SERVICE_NAME = "api";
const WEB_SERVICE_NAME = "web";
const BLOBS_SERVICE_NAME = "blobs";
const CODEC_SERVICE_NAME = "codec";
const API_PORT = 8080;
const BLOBS_PORT = 8080;
const CODEC_PORT = 8080;
const WEB_PORT = 80;
const WEB_CONTAINER_PORT = 8080;
const API_UID = 65532;
const WEB_UID = 101;

/**
 * The factory's GitHub webhook consumer (#557), reached in-cluster only: the
 * relay (webhook-relay.ts) forwards an authenticated GitHub delivery here as
 * its second target, alongside control-center's. Exported so the relay names
 * this URL rather than reconstructing the factory's own namespace, Service
 * name and port — one fact, one owner.
 */
export const FACTORY_WEBHOOK_TARGET_URL = `http://${API_SERVICE_NAME}.${SOFTWARE_FACTORY_NAMESPACE}.svc.cluster.local:${API_PORT}/v1/hooks/github`;

/**
 * Where the App's private key is mounted, and what GITHUB_APP_PRIVATE_KEY_PEM_FILE
 * points at. It holds the BASE64 TEXT of the PEM, not the PEM: the vault stores
 * it encoded (scripts/save-github-bot.sh writes `.pem | @base64`, so a
 * multi-line key survives as one value) and the kubelet strips only the
 * Secret's own base64 layer. internal/config decodes the remaining layer and
 * names this near miss explicitly, because "failed to parse PEM" otherwise
 * reads as a corrupt key and sends the reader off to rotate a good one.
 */
const APP_PRIVATE_KEY_MOUNT = "/run/secrets/github-app-private-key-pem";

/**
 * The repository this factory works tickets for. One repository, deliberately:
 * work.WorkflowID assumes it, and adding a second would change the claim
 * scheme, which costs a drain rather than a deploy.
 */
const GITHUB_OWNER = "0x63616c";
const GITHUB_REPO = "world-wide-webb";

/** Where transcripts are mounted on the WORKER — never on a sandbox. */
const TRANSCRIPTS_MOUNT_PATH = "/transcripts";

/**
 * The NAS export, and the directory under it this service owns. The kubelet
 * creates a subPath that is absent, so no NAS-side directory has to exist
 * first — but see WORKER_UID for what DOES have to be true of the export.
 */
const TRANSCRIPTS_NFS_EXPORT = "/volume1/Homelab";
const TRANSCRIPTS_SUBPATH = "software-factory/transcripts";

/**
 * Declared capacity for the transcript PV, and part of its NAME.
 *
 * Kubernetes does not enforce capacity on an NFS volume — the real ceiling is
 * the NAS export's free space — so this number is a label rather than a limit,
 * which is why it can be chosen before a single transcript has been measured.
 * The number that WILL matter is a retention policy, and there is not one yet
 * (#343, still open on that point). A bound static PVC cannot be resized in
 * place, so the capacity is in the name: changing it arrives as a new PV/PVC
 * pair rather than a mutation, exactly as component.ts does it.
 */
const TRANSCRIPTS_CAPACITY = "10Gi";
const TRANSCRIPTS_PV_NAME = `software-factory-transcripts-${TRANSCRIPTS_CAPACITY.toLowerCase()}`;

/**
 * Payload blobs are primary workflow data: every payload is retained and
 * content-addressed, with no retention policy yet. Capacity is deliberately
 * larger than transcripts and embedded in the static PV/PVC name because a
 * bound static PVC cannot be resized in place.
 */
const BLOBS_CAPACITY = "100Gi";
const BLOBS_PV_NAME = `software-factory-blobs-${BLOBS_CAPACITY.toLowerCase()}`;
const BLOBS_SUBPATH = "software-factory/blobs";
const BLOBS_MOUNT_PATH = "/blobs";
const BLOBS_URL = `http://${BLOBS_SERVICE_NAME}:${BLOBS_PORT}`;

/**
 * SOFT, with a bounded timeout. A hard mount turns an unreachable NAS into a
 * worker wedged inside its own constructor with no error to log and no
 * heartbeat to fail — the process sits in uninterruptible sleep, where even
 * SIGKILL does not land. Soft turns the same outage into an EIO the transcript
 * sink reports, at the cost of a write that can fail. That is the right trade
 * here: transcripts are a secondary record, and Temporal history is the
 * authoritative one.
 *
 * `timeo` is DECISECONDS, so 100 is 10s; 3 retransmits bounds a stuck mount at
 * roughly 30 seconds rather than forever. nfsvers=4.0 and nolock match the rest
 * of this cluster's NFS PVs — the Talos kernel does in-kernel NFSv4 only, and
 * ships no rpc.statd.
 *
 * NOT applied to the backup PVs in component.ts, deliberately: a soft mount can
 * fail a write mid-stream, and a truncated pg dump that reports success is far
 * worse than a backup job that hangs and gets noticed.
 */
const TRANSCRIPTS_MOUNT_OPTIONS = ["nfsvers=4.0", "nolock", "soft", "timeo=100", "retrans=3"];

/**
 * The uid/gid the worker image runs as — distroless's `nonroot`, and a contract
 * with images/worker/Dockerfile.
 *
 * It is also the fsGroup on the transcript volume, where it is **belt and
 * braces rather than load-bearing**, and an earlier version of this comment
 * predicted a failure that cannot happen. Measured against the live export:
 * `root_squash` IS active (a root pod's write lands `1024:100`), but every
 * directory on it is created `0777`, so the sandbox uid can write regardless.
 * And `fsGroup` is a **no-op on NFS** — the in-tree plugin does not report the
 * mount as ownership-managed, so the kubelet never runs the recursive chown,
 * which means it also cannot fail and block pod start.
 *
 * Kept anyway because it costs nothing and is correct the day this volume is
 * not NFS. Worth knowing: this is the first non-root workload on that export —
 * no existing consumer sets runAsUser, runAsNonRoot or fsGroup at all.
 */
const WORKER_UID = 65532;

/**
 * Above the drain window, so `worker.Run(worker.InterruptCh())` finishes.
 *
 * PROVISIONAL. D1 found that `worker.Options{}` leaves `WorkerStopTimeout` at
 * 0, so today there is no drain window at all — the SDK returns immediately and
 * cancels the activity contexts. Once D1 sets a real stop timeout this must be
 * sized against it rather than guessed, and 120s is a placeholder chosen to be
 * comfortably above any plausible value, not a computed one.
 */
const TERMINATION_GRACE_SECONDS = 120;

/**
 * What the worker's metrics and health server binds to (`METRICS_ADDR`).
 *
 * The port is the house's `DEFAULT_METRICS_PORT` rather than a second number,
 * so the scrape annotations below and every other workload here agree. D1's
 * test fixture uses `:9090`, but that is a fixture — `LoadWorker` requires the
 * variable and defaults nothing, so this value is what actually binds.
 */
const METRICS_ADDR = `:${DEFAULT_METRICS_PORT}`;

export interface SoftwareFactoryArgs {
  provider: k8s.Provider;
  /** The shared namespace that orders the factory's CNPG and worker resources. */
  namespace: k8s.core.v1.Namespace;
  /**
   * Decrypted vault (vault.ts): the GHCR pull token (the worker and sandbox
   * images are private; the separately installed relay has its own copy)
   * and the www-software-factory-bot App credential set. NOT the codex
   * credential — see CODEX_AUTH_SECRET_NAME.
   */
  vault: Record<string, string>;
  /**
   * The `factory.<zone>` Cloudflare Access application's audience tag
   * (#593). Sourced by the caller from the world-wide-webb-cloudflare
   * project's `accessAppAuds` stack output, NOT the vault — it's infra state
   * minted by that Access application, not a secret to hand-paste. May
   * resolve to "" before that application has been created; see the api
   * Deployment's `pulumi.com/skipAwait` annotation and createAPISecret for
   * why that never means the API serves traffic unauthenticated.
   */
  accessAud: pulumi.Input<string>;
  /** Per-service GHCR digest pins from CI, for every factory image. */
  imageDigests: ImageDigests;
  /**
   * On a production cluster, refuse to render a mutable `:main` ref. Same rule
   * serviceSpecs applies to control-center, asserted here rather than there so
   * a broken sandbox build cannot block the house's own deploy.
   */
  requireImageDigestPins: boolean;
  /** The NAS, for the transcript PV. Same server the backup PVs use. */
  nasNfsServer: string;
}

export interface SoftwareFactoryResources {
  namespace: k8s.core.v1.Namespace;
  ghcrPullSecret: k8s.core.v1.Secret;
  workerSecret: k8s.core.v1.Secret;
  apiSecret: k8s.core.v1.Secret;
  serviceAccount: k8s.core.v1.ServiceAccount;
  role: k8s.rbac.v1.Role;
  roleBinding: k8s.rbac.v1.RoleBinding;
  transcriptsVolume: k8s.core.v1.PersistentVolume;
  transcriptsClaim: k8s.core.v1.PersistentVolumeClaim;
  blobsVolume: k8s.core.v1.PersistentVolume;
  blobsClaim: k8s.core.v1.PersistentVolumeClaim;
  worker: k8s.apps.v1.Deployment;
  blobsService: k8s.core.v1.Service;
  blobs: k8s.apps.v1.Deployment;
  codecService: k8s.core.v1.Service;
  codec: k8s.apps.v1.Deployment;
  apiService: k8s.core.v1.Service;
  api: k8s.apps.v1.Deployment;
  webService: k8s.core.v1.Service;
  web: k8s.apps.v1.Deployment;
}

/**
 * @public - installs the worker in the shared `software-factory` namespace. The sandbox image is deliberately not a workload here: the worker
 * creates those pods itself at runtime, from the digest-pinned ref below.
 */
export function installSoftwareFactory(args: SoftwareFactoryArgs): SoftwareFactoryResources {
  const {
    provider,
    namespace,
    vault,
    accessAud,
    imageDigests,
    nasNfsServer,
    requireImageDigestPins,
  } = args;
  const factory = softwareFactoryProductManifest();
  const opts = { provider };

  if (requireImageDigestPins) assertImageDigestPins("software-factory", imageDigests);

  const namespaceName = namespace.metadata.name;
  const inNamespace = { ...opts, dependsOn: [namespace] };

  // Both images are private on GHCR, so this namespace needs its own copy of
  // the pull secret (a Secret is always namespace-local). The SANDBOX image is
  // pulled with this same Secret by pods the worker creates — podspec.go sets
  // `imagePullSecrets` on every sandbox pod EXPLICITLY, from
  // `SANDBOX_IMAGE_PULL_SECRET_NAME` below, which is why the name is the
  // shared GHCR_PULL_SECRET_NAME.
  //
  // There is deliberately no namespace `default`-ServiceAccount fallback:
  // #404 found the first live run failing ErrImagePull because an earlier
  // version of this comment claimed that fallback existed when it never had
  // been wired, and Kubernetes has no such default at all — a
  // `default`-ServiceAccount's `imagePullSecrets` is exactly as empty as any
  // other ServiceAccount's until something sets it.
  const pat = vault.GITHUB_PERSONAL_ACCESS_TOKEN__TOKEN;
  if (!pat) {
    throw new Error("software-factory: vault key GITHUB_PERSONAL_ACCESS_TOKEN__TOKEN not found");
  }
  const ghcrPullSecret = new k8s.core.v1.Secret(
    "software-factory-ghcr-pull",
    {
      metadata: { name: GHCR_PULL_SECRET_NAME, namespace: namespaceName },
      type: "kubernetes.io/dockerconfigjson",
      stringData: { ".dockerconfigjson": pulumi.secret(composeGhcrDockerConfigJson(pat)) },
    },
    inNamespace,
  );

  const workerSecret = createWorkerSecret(vault, namespaceName, inNamespace);
  const apiSecret = createAPISecret(vault, accessAud, namespaceName, inNamespace);

  const serviceAccount = new k8s.core.v1.ServiceAccount(
    WORKER_SERVICE_ACCOUNT,
    { metadata: { name: WORKER_SERVICE_ACCOUNT, namespace: namespaceName } },
    inNamespace,
  );

  const role = new k8s.rbac.v1.Role(
    WORKER_SERVICE_ACCOUNT,
    {
      metadata: { name: WORKER_SERVICE_ACCOUNT, namespace: namespaceName },
      // Namespace-scoped, nothing cluster-scoped. Every verb below was derived
      // by enumerating the client's actual apiserver calls rather than by
      // reasoning about them — the first draft of this list was wrong three
      // ways (ADR-0011 §Blast radius).
      rules: [
        {
          apiGroups: [""],
          resources: ["pods"],
          // `watch` is load-bearing: WaitReady is watch-based (lifecycle.go),
          // so without it EVERY sandbox start 403s. It is NOT interchangeable
          // with `list`: the authorizer maps `GET .../pods?watch=true` to
          // `watch`, so neither verb covers the other.
          //
          // `list` is the orphan sweeper's entire operation — list by label,
          // filter by age, delete. At the time of writing no `Pods().List`
          // caller has landed (grep the tree: there is none), so this is
          // granted AHEAD of its caller deliberately, to spare a second deploy
          // and because the alternative failure is a `Forbidden` that reads as
          // an infrastructure problem and gets debugged at the wrong layer.
          //
          // It widens nothing that was narrow: this rule already cannot be
          // scoped (below), so the verb adds enumeration inside a namespace
          // this ServiceAccount can already create, watch and delete in.
          //
          // This rule CANNOT be narrowed with `resourceNames`: Kubernetes
          // silently ignores that clause for `list`, `watch`, `create` and
          // `deletecollection`, and pod names carry a per-run id unknown when
          // this Role is authored. THE NAMESPACE IS THE ISOLATION BOUNDARY FOR
          // PODS, NOT THIS ROLE. Adding a resourceNames clause here would read
          // as a scoped grant while behaving as a namespace-wide one, which is
          // worse than an honest wide grant. Tighter pod isolation has to come
          // from a dedicated namespace or an admission policy.
          verbs: ["create", "get", "list", "watch", "delete"],
        },
        {
          apiGroups: [""],
          resources: ["pods/exec"],
          // `get` as well as `create`: the WebSocket executor issues a GET
          // (exec.go) and only the deprecated SPDY fallback uses POST. With
          // `create` alone every exec either silently takes the deprecated path
          // or fails outright, depending on what httpstream.IsUpgradeFailure
          // makes of a 403.
          verbs: ["get", "create"],
        },
        {
          apiGroups: [""],
          resources: ["secrets"],
          // Scoping DOES work here, and the asymmetry with pods above is
          // structural rather than an oversight: SecretClient binds namespace
          // and name at construction and exposes no method taking either, so no
          // code path could want `list`. The narrow seam and the tight RBAC are
          // one decision seen from two sides.
          resourceNames: [CODEX_AUTH_SECRET_NAME],
          verbs: ["get", "update"],
        },
        {
          apiGroups: [""],
          resources: ["secrets"],
          // The per-ticket codex-credential Secret (#434, D3): CreateSandbox
          // provisions one per run (internal/clients/k8s/lifecycle.go,
          // ensureCredentialSecret) and DeleteSandbox removes it, and the
          // orphan sweep now lists and deletes any left behind by a worker
          // that died between the two (sweep.go, sweepOrphanSecrets).
          //
          // This CANNOT be scoped with `resourceNames` the way the codex-auth
          // rule above is, for exactly the reason the pods rule above cannot
          // be either: the name carries a per-run id unknown when this Role
          // is authored, and Kubernetes ignores `resourceNames` for `list`,
          // `create` and `deletecollection` regardless. THE NAMESPACE IS THE
          // ISOLATION BOUNDARY for this rule, not a resourceNames clause —
          // stated explicitly rather than left to look like an oversight,
          // the same call already made for pods above.
          verbs: ["create", "get", "update", "delete", "list"],
        },
      ],
    },
    inNamespace,
  );

  const roleBinding = new k8s.rbac.v1.RoleBinding(
    WORKER_SERVICE_ACCOUNT,
    {
      metadata: { name: WORKER_SERVICE_ACCOUNT, namespace: namespaceName },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: WORKER_SERVICE_ACCOUNT,
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name: WORKER_SERVICE_ACCOUNT,
          namespace: SOFTWARE_FACTORY_NAMESPACE,
        },
      ],
    },
    { ...inNamespace, dependsOn: [namespace, role, serviceAccount] },
  );

  // Statically provisioned, `storageClassName: ""` — the cluster's default
  // StorageClass is local-lvm (ADR-0009), which is node-local and RWO. This
  // volume is neither.
  const transcriptsVolume = new k8s.core.v1.PersistentVolume(
    TRANSCRIPTS_PV_NAME,
    {
      metadata: { name: TRANSCRIPTS_PV_NAME },
      spec: {
        capacity: { storage: TRANSCRIPTS_CAPACITY },
        accessModes: ["ReadWriteMany"],
        mountOptions: TRANSCRIPTS_MOUNT_OPTIONS,
        nfs: { server: nasNfsServer, path: TRANSCRIPTS_NFS_EXPORT },
        storageClassName: "",
      },
    },
    opts,
  );

  const transcriptsClaim = new k8s.core.v1.PersistentVolumeClaim(
    TRANSCRIPTS_PV_NAME,
    {
      metadata: { name: TRANSCRIPTS_PV_NAME, namespace: namespaceName },
      spec: {
        accessModes: ["ReadWriteMany"],
        storageClassName: "",
        volumeName: TRANSCRIPTS_PV_NAME,
        resources: { requests: { storage: TRANSCRIPTS_CAPACITY } },
      },
    },
    { ...inNamespace, dependsOn: [namespace, transcriptsVolume] },
  );

  // Statically provisioned RWX on the shared NAS, like transcripts. Soft
  // mounts are safe here because every blob is content-addressed and verified
  // on read; a failed write cannot be mistaken for valid content. Retain keeps
  // primary payload data on the NAS if this PVC is ever deleted.
  const blobsVolume = new k8s.core.v1.PersistentVolume(
    BLOBS_PV_NAME,
    {
      metadata: { name: BLOBS_PV_NAME },
      spec: {
        capacity: { storage: BLOBS_CAPACITY },
        accessModes: ["ReadWriteMany"],
        mountOptions: TRANSCRIPTS_MOUNT_OPTIONS,
        persistentVolumeReclaimPolicy: "Retain",
        nfs: { server: nasNfsServer, path: TRANSCRIPTS_NFS_EXPORT },
        storageClassName: "",
      },
    },
    opts,
  );

  const blobsClaim = new k8s.core.v1.PersistentVolumeClaim(
    BLOBS_PV_NAME,
    {
      metadata: { name: BLOBS_PV_NAME, namespace: namespaceName },
      spec: {
        accessModes: ["ReadWriteMany"],
        storageClassName: "",
        volumeName: BLOBS_PV_NAME,
        resources: { requests: { storage: BLOBS_CAPACITY } },
      },
    },
    { ...inNamespace, dependsOn: [namespace, blobsVolume] },
  );

  const workerLabels = { app: WORKER_SERVICE_ACCOUNT };

  const worker = new k8s.apps.v1.Deployment(
    WORKER_SERVICE_ACCOUNT,
    {
      metadata: { name: WORKER_SERVICE_ACCOUNT, namespace: namespaceName, labels: workerLabels },
      spec: {
        // One replica, and Recreate rather than RollingUpdate. Two replicas
        // would mean two credential refreshers, and a rolling update over this
        // volume is the deadlock this cluster has hit before.
        //
        // Single-replica is NOT what makes the credential refresh safe — the
        // compare-and-swap lease on the Secret's resourceVersion is, and a
        // `kubectl debug` pod or a terminating pod mid-Recreate is defeated by
        // the lease and by nothing else (ADR-0011, corrected by #335).
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: workerLabels },
        template: {
          metadata: {
            labels: workerLabels,
            // On the POD TEMPLATE, not the Deployment: Prometheus `role: pod`
            // service discovery only ever sees Pods. Same shape temporal-worker
            // uses. No Service fronts this — in-cluster scraping only.
            annotations: {
              "prometheus.io/scrape": "true",
              "prometheus.io/port": String(DEFAULT_METRICS_PORT),
              "prometheus.io/path": METRICS_PATH,
            },
          },
          spec: {
            serviceAccountName: WORKER_SERVICE_ACCOUNT,
            // TRUE, and the only workload in this cluster where it is. Every
            // other Deployment sets it false deliberately; this one's whole job
            // is creating pods. The Role above is what bounds it.
            automountServiceAccountToken: true,
            imagePullSecrets: [{ name: GHCR_PULL_SECRET_NAME }],
            terminationGracePeriodSeconds: TERMINATION_GRACE_SECONDS,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: WORKER_UID,
              runAsGroup: WORKER_UID,
              // Applies to the NFS mount. See WORKER_UID: the export has to
              // cooperate for this to mean anything.
              fsGroup: WORKER_UID,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: WORKER_SERVICE_ACCOUNT,
                image: ghcrImage("software-factory-worker", imageDigests),
                env: [
                  { name: "GITHUB_OWNER", value: GITHUB_OWNER },
                  { name: "GITHUB_REPO", value: GITHUB_REPO },
                  {
                    name: "GITHUB_APP_ID",
                    valueFrom: { secretKeyRef: { name: WORKER_SECRET_NAME, key: "GITHUB_APP_ID" } },
                  },
                  {
                    name: "GITHUB_APP_INSTALLATION_ID",
                    valueFrom: {
                      secretKeyRef: { name: WORKER_SECRET_NAME, key: "GITHUB_APP_INSTALLATION_ID" },
                    },
                  },
                  { name: "GITHUB_APP_PRIVATE_KEY_PEM_FILE", value: APP_PRIVATE_KEY_MOUNT },
                  // TEMPORAL_HOST_PORT, not TEMPORAL_ADDRESS: the name is
                  // config.LoadWorker's, which requires all eleven of these and
                  // defaults none, so a misnamed one is not a degraded worker
                  // but a CrashLoopBackOff on the first start.
                  { name: "TEMPORAL_HOST_PORT", value: TEMPORAL_FRONTEND_CLUSTER_ADDRESS },
                  { name: "TEMPORAL_NAMESPACE", value: SOFTWARE_FACTORY_TEMPORAL_NAMESPACE },
                  { name: "BLOBS_URL", value: BLOBS_URL },
                  { name: "PAYLOAD_CODEC_MODE", value: "decode-only" },
                  // Binds the /metrics AND /healthz server, so an absent value
                  // costs observability and liveness together.
                  { name: "METRICS_ADDR", value: METRICS_ADDR },
                  // fieldRef, NEVER a literal. D1 uses this as the codexauth
                  // lease holder: a constant would make every restart claim the
                  // same identity, and the compare-and-swap lease that is the
                  // ONLY thing preventing two refreshers would stop
                  // distinguishing a new pod from the one it replaced.
                  {
                    name: "POD_NAME",
                    valueFrom: { fieldRef: { fieldPath: "metadata.name" } },
                  },
                  // The sandbox image, digest-pinned by the same CI map that
                  // pins this one, so a sandbox is as reproducible as the
                  // worker that created it.
                  {
                    name: "SANDBOX_IMAGE",
                    value: ghcrImage("software-factory-sandbox", imageDigests),
                  },
                  { name: "SANDBOX_NAMESPACE", value: SOFTWARE_FACTORY_NAMESPACE },
                  { name: "CODEX_AUTH_SECRET_NAME", value: CODEX_AUTH_SECRET_NAME },
                  // The Secret podspec.go sets as `imagePullSecrets` on every
                  // sandbox pod it creates (#404). Same name this Deployment's
                  // own `imagePullSecrets` above uses, because both pull the
                  // same private GHCR images with the same token.
                  { name: "SANDBOX_IMAGE_PULL_SECRET_NAME", value: GHCR_PULL_SECRET_NAME },
                  { name: "TRANSCRIPTS_ROOT", value: TRANSCRIPTS_MOUNT_PATH },
                  // config.LoadWorker's one required database input (#551):
                  // the dispatcher's per-tick RecordDispatcherState activity
                  // writes through this connection. Same variable name
                  // cmd/api reads (internal/config/api.go) — one Postgres,
                  // one spelling.
                  {
                    name: "SOFTWARE_FACTORY_DATABASE_URL",
                    valueFrom: { secretKeyRef: { name: WORKER_SECRET_NAME, key: "DATABASE_URL" } },
                  },
                ],
                volumeMounts: [
                  {
                    name: "app-private-key",
                    mountPath: APP_PRIVATE_KEY_MOUNT,
                    subPath: "private-key-pem",
                    readOnly: true,
                  },
                  {
                    name: "transcripts",
                    mountPath: TRANSCRIPTS_MOUNT_PATH,
                    // One export serves several things, so this service gets a
                    // directory rather than the root of it. The kubelet creates
                    // the subPath if it is missing.
                    subPath: TRANSCRIPTS_SUBPATH,
                  },
                  // The image has a read-only root filesystem, so anything
                  // wanting a temporary file needs somewhere to put it.
                  { name: "tmp", mountPath: "/tmp" },
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                resources: {
                  limits: { memory: "512Mi" },
                  requests: { cpu: "100m", memory: "256Mi" },
                },
              },
            ],
            volumes: [
              {
                name: "app-private-key",
                secret: {
                  secretName: WORKER_SECRET_NAME,
                  items: [{ key: "GITHUB_APP_PRIVATE_KEY_PEM", path: "private-key-pem" }],
                },
              },
              { name: "transcripts", persistentVolumeClaim: { claimName: TRANSCRIPTS_PV_NAME } },
              { name: "tmp", emptyDir: {} },
            ],
          },
        },
      },
    },
    { ...inNamespace, dependsOn: [roleBinding, workerSecret, transcriptsClaim, ghcrPullSecret] },
  );

  const blobsLabels = { app: "software-factory-blobs" };
  const blobsService = new k8s.core.v1.Service(
    BLOBS_SERVICE_NAME,
    {
      metadata: { name: BLOBS_SERVICE_NAME, namespace: namespaceName, labels: blobsLabels },
      spec: {
        type: "ClusterIP",
        selector: blobsLabels,
        ports: [{ name: "http", port: BLOBS_PORT, targetPort: BLOBS_PORT }],
      },
    },
    inNamespace,
  );
  const blobs = new k8s.apps.v1.Deployment(
    "software-factory-blobs",
    {
      metadata: { name: "software-factory-blobs", namespace: namespaceName, labels: blobsLabels },
      spec: {
        replicas: 2,
        selector: { matchLabels: blobsLabels },
        template: {
          metadata: { labels: blobsLabels },
          spec: {
            automountServiceAccountToken: false,
            imagePullSecrets: [{ name: GHCR_PULL_SECRET_NAME }],
            securityContext: {
              runAsNonRoot: true,
              runAsUser: WORKER_UID,
              runAsGroup: WORKER_UID,
              fsGroup: WORKER_UID,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: BLOBS_SERVICE_NAME,
                image: ghcrImage("software-factory-blobs", imageDigests),
                ports: [{ name: "http", containerPort: BLOBS_PORT }],
                env: [
                  { name: "BLOBS_ROOT", value: BLOBS_MOUNT_PATH },
                  { name: "LISTEN_ADDR", value: `:${BLOBS_PORT}` },
                ],
                readinessProbe: {
                  httpGet: { path: "/healthz", port: "http" },
                  initialDelaySeconds: 1,
                  periodSeconds: 5,
                },
                volumeMounts: [
                  { name: "blobs", mountPath: BLOBS_MOUNT_PATH, subPath: BLOBS_SUBPATH },
                  { name: "tmp", mountPath: "/tmp" },
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                resources: {
                  requests: { cpu: "25m", memory: "64Mi" },
                  limits: { memory: "128Mi" },
                },
              },
            ],
            volumes: [
              { name: "blobs", persistentVolumeClaim: { claimName: BLOBS_PV_NAME } },
              { name: "tmp", emptyDir: {} },
            ],
          },
        },
      },
    },
    { ...inNamespace, dependsOn: [blobsClaim, blobsService, ghcrPullSecret] },
  );

  const codecLabels = { app: "software-factory-codec" };
  const codecService = new k8s.core.v1.Service(
    CODEC_SERVICE_NAME,
    {
      metadata: { name: CODEC_SERVICE_NAME, namespace: namespaceName, labels: codecLabels },
      spec: {
        type: "ClusterIP",
        selector: codecLabels,
        ports: [{ name: "http", port: CODEC_PORT, targetPort: CODEC_PORT }],
      },
    },
    inNamespace,
  );
  const codec = new k8s.apps.v1.Deployment(
    "software-factory-codec",
    {
      metadata: { name: "software-factory-codec", namespace: namespaceName, labels: codecLabels },
      spec: {
        replicas: 1,
        selector: { matchLabels: codecLabels },
        template: {
          metadata: { labels: codecLabels },
          spec: {
            automountServiceAccountToken: false,
            imagePullSecrets: [{ name: GHCR_PULL_SECRET_NAME }],
            securityContext: {
              runAsNonRoot: true,
              runAsUser: WORKER_UID,
              runAsGroup: WORKER_UID,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: CODEC_SERVICE_NAME,
                image: ghcrImage("software-factory-codec", imageDigests),
                ports: [{ name: "http", containerPort: CODEC_PORT }],
                env: [
                  { name: "BLOBS_URL", value: BLOBS_URL },
                  {
                    name: "CODEC_CORS_ORIGINS",
                    value: [
                      `https://${controlCenterProductManifest().temporalUi.exposure.hostname}`,
                      "http://localhost:8080",
                    ].join(","),
                  },
                  { name: "LISTEN_ADDR", value: `:${CODEC_PORT}` },
                ],
                readinessProbe: {
                  httpGet: { path: "/healthz", port: "http" },
                  initialDelaySeconds: 1,
                  periodSeconds: 5,
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                resources: {
                  requests: { cpu: "25m", memory: "64Mi" },
                  limits: { memory: "128Mi" },
                },
              },
            ],
          },
        },
      },
    },
    { ...inNamespace, dependsOn: [codecService, ghcrPullSecret] },
  );

  const apiLabels = { app: "software-factory-api" };
  const apiService = new k8s.core.v1.Service(
    API_SERVICE_NAME,
    {
      metadata: { name: API_SERVICE_NAME, namespace: namespaceName, labels: apiLabels },
      spec: {
        type: "ClusterIP",
        selector: apiLabels,
        ports: [{ name: "http", port: API_PORT, targetPort: API_PORT }],
      },
    },
    inNamespace,
  );
  const api = new k8s.apps.v1.Deployment(
    "software-factory-api",
    {
      metadata: {
        name: "software-factory-api",
        namespace: namespaceName,
        labels: apiLabels,
        // skipAwait (#593): on the FIRST apply after the factory's Access
        // application is wired up, `accessAud` can still be "" — the
        // separate world-wide-webb-cloudflare project hasn't minted
        // `factory.<zone>` yet, so there's nothing to read via
        // StackReference. cmd/api's own config.LoadAPI (apps/software-factory
        // /internal/config/api.go) already refuses to start on an empty
        // audience rather than skip validation, so that apply would
        // otherwise CrashLoopBackOff forever and fail `pulumi up` on THIS
        // Deployment's rollout — reintroducing the exact whole-cluster
        // deadlock this AUD wiring exists to break. Same precedent as Plex's
        // GPU-pending skipAwait (services.ts) for a workload that cannot yet
        // become Ready. Once the AUD is real, the pod comes up healthy same
        // as any other deploy; this annotation just stops a still-missing
        // AUD from blocking the rest of the cluster's convergence.
        annotations: { "pulumi.com/skipAwait": "true" },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: apiLabels },
        template: {
          metadata: {
            labels: apiLabels,
            annotations: {
              "prometheus.io/scrape": "true",
              "prometheus.io/port": String(DEFAULT_METRICS_PORT),
              "prometheus.io/path": METRICS_PATH,
            },
          },
          spec: {
            automountServiceAccountToken: false,
            imagePullSecrets: [{ name: GHCR_PULL_SECRET_NAME }],
            securityContext: {
              runAsNonRoot: true,
              runAsUser: API_UID,
              runAsGroup: API_UID,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: API_SERVICE_NAME,
                image: ghcrImage("software-factory-api", imageDigests),
                ports: [
                  { name: "http", containerPort: API_PORT },
                  { name: "metrics", containerPort: DEFAULT_METRICS_PORT },
                ],
                env: [
                  { name: "API_ADDR", value: `:${API_PORT}` },
                  { name: "METRICS_ADDR", value: METRICS_ADDR },
                  { name: "TEMPORAL_HOST_PORT", value: TEMPORAL_FRONTEND_CLUSTER_ADDRESS },
                  { name: "TEMPORAL_NAMESPACE", value: SOFTWARE_FACTORY_TEMPORAL_NAMESPACE },
                  ...[
                    "CLOUDFLARE_ACCESS_TEAM_DOMAIN",
                    "CLOUDFLARE_ACCESS_AUD",
                    "SOFTWARE_FACTORY_API__WORKER_BEARER_TOKEN",
                    "SOFTWARE_FACTORY_API__SANDBOX_BEARER_TOKEN",
                    "GITHUB_BOT_APP__WEBHOOK_SECRET",
                  ].map((name) => ({
                    name,
                    valueFrom: { secretKeyRef: { name: API_SECRET_NAME, key: name } },
                  })),
                  { name: "SOFTWARE_FACTORY_DATABASE_USER", value: factory.database.owner },
                  { name: "SOFTWARE_FACTORY_DATABASE_HOST", value: factory.database.rwServiceName },
                  { name: "SOFTWARE_FACTORY_DATABASE_NAME", value: factory.database.databaseName },
                  {
                    name: "SOFTWARE_FACTORY_DATABASE_PASSWORD",
                    valueFrom: {
                      secretKeyRef: { name: factory.database.authSecretName, key: "password" },
                    },
                  },
                ],
                readinessProbe: {
                  httpGet: { path: "/healthz", port: "http" },
                  initialDelaySeconds: 1,
                  periodSeconds: 5,
                },
                livenessProbe: {
                  httpGet: { path: "/healthz", port: "http" },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                resources: {
                  requests: { cpu: "25m", memory: "64Mi" },
                  limits: { memory: "128Mi" },
                },
              },
            ],
          },
        },
      },
    },
    { ...inNamespace, dependsOn: [ghcrPullSecret, apiSecret, apiService] },
  );

  const webLabels = { app: "software-factory-web" };
  const webService = new k8s.core.v1.Service(
    WEB_SERVICE_NAME,
    {
      metadata: { name: WEB_SERVICE_NAME, namespace: namespaceName, labels: webLabels },
      spec: {
        type: "ClusterIP",
        selector: webLabels,
        ports: [{ name: "http", port: WEB_PORT, targetPort: WEB_CONTAINER_PORT }],
      },
    },
    inNamespace,
  );
  const web = new k8s.apps.v1.Deployment(
    "software-factory-web",
    {
      metadata: { name: "software-factory-web", namespace: namespaceName, labels: webLabels },
      spec: {
        replicas: 1,
        selector: { matchLabels: webLabels },
        template: {
          metadata: { labels: webLabels },
          spec: {
            automountServiceAccountToken: false,
            imagePullSecrets: [{ name: GHCR_PULL_SECRET_NAME }],
            securityContext: {
              runAsNonRoot: true,
              runAsUser: WEB_UID,
              runAsGroup: WEB_UID,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: WEB_SERVICE_NAME,
                image: ghcrImage("software-factory-console", imageDigests),
                ports: [{ name: "http", containerPort: WEB_CONTAINER_PORT }],
                volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "64Mi" } },
              },
            ],
            volumes: [{ name: "tmp", emptyDir: {} }],
          },
        },
      },
    },
    { ...inNamespace, dependsOn: [ghcrPullSecret, webService] },
  );

  return {
    namespace,
    ghcrPullSecret,
    workerSecret,
    apiSecret,
    serviceAccount,
    role,
    roleBinding,
    transcriptsVolume,
    transcriptsClaim,
    blobsVolume,
    blobsClaim,
    worker,
    blobsService,
    blobs,
    codecService,
    codec,
    apiService,
    api,
    webService,
    web,
  };
}

function createAPISecret(
  vault: Record<string, string>,
  accessAud: pulumi.Input<string>,
  namespaceName: pulumi.Input<string>,
  opts: pulumi.CustomResourceOptions,
): k8s.core.v1.Secret {
  const fromVault = (key: string): string => {
    const value = vault[key];
    if (!value) throw new Error(`software-factory: vault key ${key} not found`);
    return value;
  };
  return new k8s.core.v1.Secret(
    API_SECRET_NAME,
    {
      metadata: { name: API_SECRET_NAME, namespace: namespaceName },
      stringData: {
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: pulumi.secret(
          fromVault("SOFTWARE_FACTORY_CLOUDFLARE_ACCESS__TEAM_DOMAIN"),
        ),
        // NOT a vault key (#593): the audience is derived infra state minted
        // by the world-wide-webb-cloudflare project's Access application, read
        // via StackReference by the caller (infra/program.ts) and passed in
        // here. May be "" before that app exists yet — see the api
        // Deployment's `pulumi.com/skipAwait` annotation above for why that
        // can never mean the API serves traffic unauthenticated.
        CLOUDFLARE_ACCESS_AUD: pulumi.secret(accessAud),
        SOFTWARE_FACTORY_API__WORKER_BEARER_TOKEN: pulumi.secret(
          fromVault("SOFTWARE_FACTORY_API__WORKER_BEARER_TOKEN"),
        ),
        SOFTWARE_FACTORY_API__SANDBOX_BEARER_TOKEN: pulumi.secret(
          fromVault("SOFTWARE_FACTORY_API__SANDBOX_BEARER_TOKEN"),
        ),
        // The same GitHub App webhook secret the relay verifies with
        // (webhook-relay.ts) — internal/webhook (#557) verifies it a second
        // time, deliberately, until #532 closes the sandbox network hole; see
        // that package's own doc comment.
        GITHUB_BOT_APP__WEBHOOK_SECRET: pulumi.secret(fromVault("GITHUB_BOT_APP__WEBHOOK_SECRET")),
      },
    },
    opts,
  );
}

/**
 * The worker's config Secret: the www-software-factory-bot App credential set,
 * from the SOPS vault.
 *
 * The codex credential is NOT here and never will be — it rotates on first use,
 * so anything Pulumi owns is a corpse by the next apply (#344).
 */
function createWorkerSecret(
  vault: Record<string, string>,
  namespaceName: pulumi.Input<string>,
  opts: pulumi.CustomResourceOptions,
): k8s.core.v1.Secret {
  const fromVault = (key: string): string => {
    const value = vault[key];
    if (!value) throw new Error(`software-factory: vault key ${key} not found`);
    return value;
  };

  // Composed here, not split into POSTGRES_HOST + a mounted password file the
  // way temporal-worker's TypeScript app does: config.LoadWorker requires one
  // SOFTWARE_FACTORY_DATABASE_URL DSN (the same variable name cmd/api already
  // reads), and Pulumi already holds the plaintext password from the vault to
  // bridge into the CNPG auth Secret (cnpg.ts's createAuthSecret) — so it can
  // compose the one DSN this Go process actually wants, the same way
  // GITHUB_APP_ID and friends below are composed once here rather than
  // reconstructed from parts at runtime.
  const databaseURL = pulumi.secret(
    pulumi.interpolate`postgres://${softwareFactoryDatabase.owner}:${fromVault(softwareFactoryDatabase.auth.password.vaultKey)}@${softwareFactoryDatabase.rwServiceName}:${DATABASE_PORT}/${softwareFactoryDatabase.databaseName}`,
  );

  return new k8s.core.v1.Secret(
    "software-factory-worker-secrets",
    {
      metadata: { name: WORKER_SECRET_NAME, namespace: namespaceName },
      stringData: {
        GITHUB_APP_ID: pulumi.secret(fromVault("GITHUB_BOT_APP__APP_ID")),
        GITHUB_APP_INSTALLATION_ID: pulumi.secret(fromVault("GITHUB_BOT_APP__INSTALLATION_ID")),
        // Stays base64-encoded on purpose. See APP_PRIVATE_KEY_MOUNT.
        GITHUB_APP_PRIVATE_KEY_PEM: pulumi.secret(fromVault("GITHUB_BOT_APP__PRIVATE_KEY_PEM")),
        DATABASE_URL: databaseURL,
      },
    },
    opts,
  );
}
