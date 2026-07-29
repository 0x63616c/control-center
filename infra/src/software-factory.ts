// The `software-factory` k8s namespace and its worker (ADR-0011): the Go
// Temporal worker that works GitHub tickets, and the per-ticket sandboxes it
// runs agent-authored code in.
//
// L1: NOT in cluster.ts's closed InfraNamespaceName map — this module creates
// its own namespace, the same way homeassistant.ts and temporal.ts do. That map
// is derived from `ProductSlug`, and while software-factory IS a ProductSlug
// (for image naming — its images are `www-software-factory-*`), it is excluded
// from InfraNamespaceName deliberately: it has no CNPG database, no ESO secrets
// and no part in the control-center deploy, and widening that union would force
// an entry in every `Record<InfraNamespaceName, …>` consumer for a namespace
// that needs none of them.
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
import { controlCenterProductManifest } from "@www/platform";
import { DEFAULT_METRICS_PORT, METRICS_PATH } from "@www/platform/metrics/port";
import { GHCR_PULL_SECRET_NAME } from "./ghcr-pull-secrets.ts";
import {
  assertImageDigestPins,
  composeGhcrDockerConfigJson,
  ghcrImage,
  type ImageDigests,
} from "./services.ts";
import {
  SOFTWARE_FACTORY_TEMPORAL_NAMESPACE,
  TEMPORAL_FRONTEND_CLUSTER_ADDRESS,
} from "./temporal.ts";

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

/**
 * The Temporal UI's base URL, for the run link in a ticket's status comment
 * (A3, #331). A3 built `Pickup.RunURL` as pure data — empty renders the run id
 * as plain text, non-empty renders a link — and left the base to F1.
 *
 * It is DERIVED from the platform manifest, not spelled again: the UI is
 * already exposed at `temporal-ui.worldwidewebb.co` through the Cloudflare
 * tunnel and gated by an Access email-OTP app, the same treatment Grafana and
 * pgAdmin get (`infra/cloudflare/src/{routes,access}.ts`). So no new hostname,
 * no Access app and no manual `infra/cloudflare` apply is needed here — the
 * decision this ticket "owed" turns out to have been made and shipped already,
 * and the only thing missing was handing the worker the address.
 *
 * Chosen over leaving it empty because there is no dry-run mode: the first
 * end-to-end run opens a real PR, and whoever watches it wants the history one
 * click away rather than a run id to paste into a URL by hand.
 */
const temporalUiBaseUrl = (): string =>
  `https://${controlCenterProductManifest().temporalUi.exposure.hostname}`;

export interface SoftwareFactoryArgs {
  provider: k8s.Provider;
  /**
   * Decrypted vault (vault.ts): the GHCR pull token (both images are private)
   * and the www-software-factory-bot App credential set. NOT the codex
   * credential — see CODEX_AUTH_SECRET_NAME.
   */
  vault: Record<string, string>;
  /** Per-service GHCR digest pins from CI, for both software-factory images. */
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
  serviceAccount: k8s.core.v1.ServiceAccount;
  role: k8s.rbac.v1.Role;
  roleBinding: k8s.rbac.v1.RoleBinding;
  transcriptsVolume: k8s.core.v1.PersistentVolume;
  transcriptsClaim: k8s.core.v1.PersistentVolumeClaim;
  worker: k8s.apps.v1.Deployment;
}

/**
 * @public - installs the `software-factory` namespace and the worker that runs
 * in it. The sandbox image is deliberately not a workload here: the worker
 * creates those pods itself at runtime, from the digest-pinned ref below.
 */
export function installSoftwareFactory(args: SoftwareFactoryArgs): SoftwareFactoryResources {
  const { provider, vault, imageDigests, nasNfsServer, requireImageDigestPins } = args;
  const opts = { provider };

  if (requireImageDigestPins) assertImageDigestPins("software-factory", imageDigests);

  // No Pod Security label: the cluster-default `baseline` applies. The sandbox
  // needs hardening, not privilege, so nothing here should be relaxing
  // admission for the whole namespace — anything that needs more has to argue
  // for it at the point it lands, the way homeassistant.ts does.
  const namespace = new k8s.core.v1.Namespace(
    SOFTWARE_FACTORY_NAMESPACE,
    { metadata: { name: SOFTWARE_FACTORY_NAMESPACE } },
    opts,
  );
  const namespaceName = namespace.metadata.name;
  const inNamespace = { ...opts, dependsOn: [namespace] };

  // Both images are private on GHCR, so this namespace needs its own copy of
  // the pull secret (a Secret is always namespace-local). The SANDBOX image is
  // pulled with this same Secret by pods the worker creates — podspec.go sets
  // no imagePullSecrets, so those pods fall back to this namespace's default
  // ServiceAccount, which is why the name is the shared GHCR_PULL_SECRET_NAME.
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
                  // Read ONLY on the dispatcher workflow's first-ever start —
                  // after that its config lives in workflow state and rides
                  // ContinueAsNew, so this env var is read, logged, and then
                  // ignored (see the "dispatcher_starting_config" log in
                  // cmd/worker/main.go). It exists to make that one first
                  // start come up paused, not to let a redeploy pause or
                  // unpause a dispatcher that has already started — that's an
                  // UpdateConfig signal instead. Flip this only for the
                  // moment before registration lands; unpausing later is a
                  // signal, not a value here (see #381).
                  { name: "DISPATCHER_CONFIG", value: JSON.stringify({ paused: true }) },
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
                  // config.LoadWorker's, which requires all eight of these and
                  // defaults none, so a misnamed one is not a degraded worker
                  // but a CrashLoopBackOff on the first start.
                  { name: "TEMPORAL_HOST_PORT", value: TEMPORAL_FRONTEND_CLUSTER_ADDRESS },
                  { name: "TEMPORAL_NAMESPACE", value: SOFTWARE_FACTORY_TEMPORAL_NAMESPACE },
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
                  { name: "TRANSCRIPTS_ROOT", value: TRANSCRIPTS_MOUNT_PATH },
                  { name: "TEMPORAL_UI_BASE_URL", value: temporalUiBaseUrl() },
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

  return {
    namespace,
    ghcrPullSecret,
    workerSecret,
    serviceAccount,
    role,
    roleBinding,
    transcriptsVolume,
    transcriptsClaim,
    worker,
  };
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

  return new k8s.core.v1.Secret(
    "software-factory-worker-secrets",
    {
      metadata: { name: WORKER_SECRET_NAME, namespace: namespaceName },
      stringData: {
        GITHUB_APP_ID: pulumi.secret(fromVault("GITHUB_BOT_APP__APP_ID")),
        GITHUB_APP_INSTALLATION_ID: pulumi.secret(fromVault("GITHUB_BOT_APP__INSTALLATION_ID")),
        // Stays base64-encoded on purpose. See APP_PRIVATE_KEY_MOUNT.
        GITHUB_APP_PRIVATE_KEY_PEM: pulumi.secret(fromVault("GITHUB_BOT_APP__PRIVATE_KEY_PEM")),
      },
    },
    opts,
  );
}
