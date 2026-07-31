import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// ──────────────────────────────────────────────
// Types (formerly spec.ts)
// ──────────────────────────────────────────────

export interface SecretRef {
  name: string;
  ref: string;
}

export interface ResourceSpec {
  memory?: string;
  // reserveCpus sets ONLY requests.cpu — there is deliberately no `limitCpus`
  // sibling field. CPU is compressible (CFS quota throttles a container even
  // when the node has idle CPU, causing latency spikes with zero benefit —
  // https://home.robusta.dev/blog/stop-using-cpu-limits), unlike memory, which
  // is incompressible and gets an OOM-kill if unbounded, hence the `memory`
  // limit above. Do not add a CPU-limit field here to be "consistent" with
  // memory; the asymmetry is intentional. reserveCpus alone (requests-only)
  // already gives fair-share guarantees under contention. Enforced by
  // infra/test/render.test.ts's "never sets limits.cpu" sweep over every
  // declared workload (#87).
  reserveCpus?: string;
  reserveMemory?: string;
  // GPU units (nvidia.com/gpu). Kubernetes extended resources require
  // limits === requests (no overcommit), so buildPod sets both to this value.
  // Only meaningful alongside a runtimeClassName (Task 4: Plex/HA transcode on
  // the Talos node's RTX 3060 via the `nvidia` RuntimeClass); absent
  // everywhere on "orbstack" today.
  gpu?: number;
}

export interface PortSpec {
  containerPort: number;
  expose: "cluster" | "lan" | "none";
}

export interface VolumeSpec {
  mountPath: string;
  claim?: string;
  nfs?: { server: string; path: string };
  subPath?: string;
  readOnly?: boolean;
}

export interface InitContainerSpec {
  name: string;
  image: string;
  command?: string[];
  env?: Record<string, string>;
  volumes?: VolumeSpec[];
}

export interface WorkloadSpec {
  logicalName?: string;
  // Pulumi state alias for one-time namespace/product-name migrations.
  legacyLogicalName?: string;
  name: string;
  image: string;
  replicas: number;
  resources?: ResourceSpec;
  secrets?: SecretRef[];
  env?: Record<string, string>;
  command?: string[];
  ports?: PortSpec[];
  // Pin the LoadBalancer Service to a fixed LAN address instead of letting the
  // allocator pick. MetalLB's pool is a small shared range, so an unpinned
  // Service silently takes whichever address is free at create time - fine
  // until two Services are recreated in a different order and swap addresses,
  // which breaks anything that hardcodes one of them (Plex's ADVERTISE_IP, the
  // guest DNS record). Ignored unless a port is exposed "lan".
  loadBalancerIp?: string;
  volumes?: VolumeSpec[];
  secretName?: string;
  imagePullSecrets?: string[];
  extraSecretMounts?: {
    secretName: string;
    mountPath: string;
    items?: { key: string; path: string }[];
  }[];
  initContainers?: InitContainerSpec[];
  // hostNetwork + dnsPolicy: Task 4's HA workload binds :8123 in the NODE's
  // netns (Talos has no equivalent to the mini's tailnet-routed socat), so
  // other pods reach it at the node LAN IP (see services.ts haTarget).
  // dnsPolicy MUST be "ClusterFirstWithHostNet" alongside hostNetwork, or the
  // pod loses in-cluster DNS entirely (plain "ClusterFirst" only applies to
  // non-hostNetwork pods). Absent everywhere on "orbstack" today.
  hostNetwork?: boolean;
  dnsPolicy?: "ClusterFirst" | "ClusterFirstWithHostNet" | "Default" | "None";
  // RuntimeClass name (Task 4: "nvidia", for Plex/HA GPU transcode on the
  // Talos node's RTX 3060). Absent everywhere on "orbstack" today.
  runtimeClassName?: string;
  // Annotations to stamp on the Deployment's metadata. The pulumi-kubernetes
  // provider reads its own `pulumi.com/*` await-control keys from here (e.g.
  // `pulumi.com/skipAwait: "true"` to not block the deploy on a workload that
  // cannot become Ready — Plex on talos, parked pending the GPU device plugin).
  annotations?: Record<string, string>;
  // Declares this workload as a Prometheus scrape target (#214). Rendered onto
  // the POD TEMPLATE's annotations, deliberately NOT onto `annotations` above:
  // Prometheus's `role: pod` service discovery only ever sees Pod objects, so
  // an annotation that lands on the Deployment is invisible to it and
  // discovery silently finds nothing.
  //
  // `port` is required rather than optional because Prometheus 3.x no longer
  // appends a default port to a discovered address — a pod annotated
  // `prometheus.io/scrape: "true"` with no `prometheus.io/port` resolves to a
  // bare pod IP and the target fails. Making it non-optional means the
  // annotation set is never half-declared.
  //
  // Scraping is pod-IP direct, so the metrics port needs no Service and must
  // NOT be added to `ports` — anything exposed there becomes a Service and, for
  // the api, reachable through the Cloudflare tunnel.
  scrape?: { port: number; path?: string };
}

export interface CronJobSpec {
  logicalName?: string;
  // Pulumi state alias for one-time namespace/product-name migrations.
  legacyLogicalName?: string;
  name: string;
  image: string;
  schedule: string;
  command?: string[];
  secrets?: SecretRef[];
  env?: Record<string, string>;
  resources?: ResourceSpec;
  volumes?: VolumeSpec[];
  secretName?: string;
  suspend?: boolean;
  // Job-level wall-clock cap (seconds). Without this, a pod wedged in
  // ContainerCreating/Running (e.g. a CSI NodePublishVolume idempotency bug
  // that leaves it stuck forever, #<TBD>) blocks every future scheduled run
  // under concurrencyPolicy: Forbid until someone manually deletes it.
  activeDeadlineSeconds?: number;
  extraSecretMounts?: {
    secretName: string;
    mountPath: string;
    items?: { key: string; path: string }[];
  }[];
  imagePullSecrets?: string[];
}

// ──────────────────────────────────────────────
// Internal render types (formerly in render.ts)
// ──────────────────────────────────────────────

interface EnvVar {
  name: string;
  value: string;
}

interface VolumeMount {
  name: string;
  mountPath: string;
  readOnly?: boolean;
  subPath?: string;
}

interface PodVolume {
  name: string;
  secret?: { secretName: string; items?: { key: string; path: string }[] };
  persistentVolumeClaim?: { claimName: string };
}

interface Container {
  name: string;
  image: string;
  command?: string[];
  env: EnvVar[];
  resources: { limits: Record<string, string>; requests: Record<string, string> };
  volumeMounts: VolumeMount[];
}

interface DeploymentArgs {
  metadata: { name: string; labels: Record<string, string>; annotations?: Record<string, string> };
  spec: {
    replicas: number;
    selector: { matchLabels: Record<string, string> };
    strategy?: { type: "Recreate"; rollingUpdate: null };
    template: {
      metadata: { labels: Record<string, string>; annotations?: Record<string, string> };
      spec: {
        containers: Container[];
        initContainers?: Container[];
        volumes: PodVolume[];
        imagePullSecrets?: { name: string }[];
        automountServiceAccountToken?: boolean;
        hostNetwork?: boolean;
        dnsPolicy?: string;
        runtimeClassName?: string;
      };
    };
  };
}

interface ServiceArgs {
  metadata: { name: string; labels: Record<string, string> };
  spec: {
    type: "ClusterIP" | "LoadBalancer";
    selector?: Record<string, string>;
    loadBalancerIP?: string;
    ports: { name: string; port: number; targetPort: number }[];
  };
}

interface ExternalNameServiceArgs {
  metadata: { name: string; labels: Record<string, string> };
  spec: { type: "ExternalName"; externalName: string };
}

export interface RenderedExternalService {
  service: ExternalNameServiceArgs;
}

interface PersistentVolumeArgs {
  metadata: { name: string };
  spec: {
    capacity: Record<string, string>;
    accessModes: string[];
    mountOptions: string[];
    nfs: { server: string; path: string };
    storageClassName: string;
  };
}

interface PersistentVolumeClaimArgs {
  metadata: { name: string };
  spec: {
    accessModes: string[];
    storageClassName: string;
    volumeName: string;
    resources: { requests: { storage: string } };
  };
}

export interface RenderedWorkload {
  deployment: DeploymentArgs;
  services: ServiceArgs[];
  persistentVolumes: PersistentVolumeArgs[];
  persistentVolumeClaims: PersistentVolumeClaimArgs[];
}

interface CronJobArgs {
  metadata: { name: string; labels: Record<string, string> };
  spec: {
    schedule: string;
    suspend: boolean;
    concurrencyPolicy: "Forbid";
    successfulJobsHistoryLimit: number;
    failedJobsHistoryLimit: number;
    jobTemplate: {
      spec: {
        activeDeadlineSeconds?: number;
        template: {
          metadata: { labels: Record<string, string> };
          spec: {
            containers: Container[];
            volumes: PodVolume[];
            restartPolicy: "Never";
            automountServiceAccountToken: boolean;
            imagePullSecrets?: { name: string }[];
          };
        };
      };
    };
  };
}

export interface RenderedCronJob {
  cronJob: CronJobArgs;
  persistentVolumes: PersistentVolumeArgs[];
  persistentVolumeClaims: PersistentVolumeClaimArgs[];
}

// ──────────────────────────────────────────────
// Pure mapping layer (formerly render.ts)
// ──────────────────────────────────────────────

// The Talos node's kernel does in-kernel NFSv4 mounts only (no working NFSv3
// helper path), so v3 mounts fail with "incorrect mount option". NFSv4.0 is
// enabled on the DS420+ and mounts cleanly. `nolock` stays (Talos has no
// rpc.statd); bare `tcp` is dropped (NFSv4 is TCP-only by default).
const NFS_MOUNT_OPTIONS = ["nfsvers=4.0", "nolock"];

/**
 * Declared capacity for statically-provisioned NFS PVs (pg-backup, media
 * mounts). Kubernetes does not enforce capacity on NFS volumes , the real
 * ceiling is the NAS export's free space , but the declaration should stay
 * ahead of actual usage so the objects read honestly (the pg dumps outgrew the
 * old 1Gi label once frontend logs landed in Postgres).
 *
 * The capacity is part of the PV/PVC NAME (see buildPod): a bound static PVC
 * cannot be resized in place ("only dynamically provisioned pvc can be
 * resized"), so a capacity change must arrive as a new PV/PVC pair, not a
 * mutation. Renaming forces exactly that , the NFS export underneath is
 * untouched, only the pointer objects churn.
 */
const NFS_PV_CAPACITY = "10Gi";
const NFS_PV_NAME_SUFFIX = `-${NFS_PV_CAPACITY.toLowerCase()}`;

function sizeToMib(size: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([KMG])?i?B?$/i.exec(size.trim());
  if (!m) throw new Error(`unparseable memory size: ${size}`);
  const value = Number(m[1]);
  const unit = (m[2] ?? "M").toUpperCase();
  const mult = unit === "G" ? 1024 : unit === "K" ? 1 / 1024 : 1;
  return value * mult;
}

function defaultRequestMemory(limit: string): string {
  const half = Math.max(32, Math.floor(sizeToMib(limit) / 2));
  return `${half}M`;
}

interface PodInputs {
  name: string;
  image: string;
  command?: string[];
  resources?: ResourceSpec;
  secrets?: SecretRef[];
  env?: Record<string, string>;
  volumes?: VolumeSpec[];
  secretName?: string;
  extraSecretMounts?: {
    secretName: string;
    mountPath: string;
    items?: { key: string; path: string }[];
  }[];
}

function claimVolumeName(claimVolumeNames: Map<string, string>, claim: string, fallback: string) {
  const existing = claimVolumeNames.get(claim);
  if (existing) return existing;
  claimVolumeNames.set(claim, fallback);
  return fallback;
}

function buildPod(p: PodInputs): {
  container: Container;
  podVolumes: PodVolume[];
  persistentVolumes: PersistentVolumeArgs[];
  persistentVolumeClaims: PersistentVolumeClaimArgs[];
} {
  const limits: Record<string, string> = {};
  const requests: Record<string, string> = {};
  if (p.resources?.memory) {
    limits.memory = p.resources.memory;
    requests.memory = p.resources.reserveMemory ?? defaultRequestMemory(p.resources.memory);
  }
  // requests.cpu ONLY, never limits.cpu — see the ResourceSpec.reserveCpus
  // comment above (#87: CPU limits cause CFS-quota throttling with no benefit;
  // requests alone give fair-share scheduling). There is no ResourceSpec field
  // that could set limits.cpu, so this can't quietly regress.
  if (p.resources?.reserveCpus) {
    requests.cpu = p.resources.reserveCpus;
  }
  if (p.resources?.gpu) {
    // Extended resources (nvidia.com/gpu) do not support overcommit: the
    // scheduler requires limits === requests, unlike memory/cpu above.
    limits["nvidia.com/gpu"] = String(p.resources.gpu);
    requests["nvidia.com/gpu"] = String(p.resources.gpu);
  }

  const env: EnvVar[] = Object.entries(p.env ?? {}).map(([name, value]) => ({ name, value }));

  const volumeMounts: VolumeMount[] = [];
  const podVolumes: PodVolume[] = [];
  const persistentVolumes: PersistentVolumeArgs[] = [];
  const persistentVolumeClaims: PersistentVolumeClaimArgs[] = [];
  const claimVolumeNames = new Map<string, string>();

  if (p.secrets && p.secrets.length > 0) {
    volumeMounts.push({ name: "secrets", mountPath: "/run/secrets", readOnly: true });
    podVolumes.push({
      name: "secrets",
      secret: { secretName: p.secretName ?? `${p.name}-secrets` },
    });
  }

  for (const [i, m] of (p.extraSecretMounts ?? []).entries()) {
    const volName = `xsec-${i}`;
    volumeMounts.push({ name: volName, mountPath: m.mountPath, readOnly: true });
    podVolumes.push({
      name: volName,
      secret: { secretName: m.secretName, ...(m.items ? { items: m.items } : {}) },
    });
  }

  for (const [i, vol] of (p.volumes ?? []).entries()) {
    const fallbackVolName = `vol-${i}`;
    const volName = vol.claim
      ? claimVolumeName(claimVolumeNames, vol.claim, fallbackVolName)
      : fallbackVolName;
    volumeMounts.push({
      name: volName,
      mountPath: vol.mountPath,
      readOnly: vol.readOnly,
      ...(vol.subPath ? { subPath: vol.subPath } : {}),
    });
    if (vol.nfs) {
      const pvName = `${p.name}-${volName}${NFS_PV_NAME_SUFFIX}`;
      persistentVolumes.push({
        metadata: { name: pvName },
        spec: {
          capacity: { storage: NFS_PV_CAPACITY },
          accessModes: ["ReadWriteMany"],
          mountOptions: NFS_MOUNT_OPTIONS,
          nfs: { server: vol.nfs.server, path: vol.nfs.path },
          storageClassName: "",
        },
      });
      persistentVolumeClaims.push({
        metadata: { name: pvName },
        spec: {
          accessModes: ["ReadWriteMany"],
          storageClassName: "",
          volumeName: pvName,
          resources: { requests: { storage: NFS_PV_CAPACITY } },
        },
      });
      podVolumes.push({ name: volName, persistentVolumeClaim: { claimName: pvName } });
    } else if (vol.claim) {
      if (volName === fallbackVolName) {
        podVolumes.push({ name: volName, persistentVolumeClaim: { claimName: vol.claim } });
      }
    }
  }

  const container: Container = {
    name: p.name,
    image: p.image,
    ...(p.command ? { command: p.command } : {}),
    env,
    resources: { limits, requests },
    volumeMounts,
  };

  return { container, podVolumes, persistentVolumes, persistentVolumeClaims };
}

function buildInitContainer(
  ic: InitContainerSpec,
  idx: number,
  claimVolumeNames: Map<string, string>,
): { container: Container; podVolumes: PodVolume[] } {
  const volumeMounts: VolumeMount[] = [];
  const podVolumes: PodVolume[] = [];
  for (const [j, vol] of (ic.volumes ?? []).entries()) {
    if (!vol.claim) {
      throw new Error(`initContainer ${ic.name}: only claim-named PVC volumes are supported`);
    }
    const fallbackVolName = `init${idx}-vol-${j}`;
    const volName = claimVolumeName(claimVolumeNames, vol.claim, fallbackVolName);
    volumeMounts.push({
      name: volName,
      mountPath: vol.mountPath,
      ...(vol.readOnly ? { readOnly: true } : {}),
      ...(vol.subPath ? { subPath: vol.subPath } : {}),
    });
    if (volName === fallbackVolName) {
      podVolumes.push({ name: volName, persistentVolumeClaim: { claimName: vol.claim } });
    }
  }
  return {
    container: {
      name: ic.name,
      image: ic.image,
      ...(ic.command ? { command: ic.command } : {}),
      env: Object.entries(ic.env ?? {}).map(([name, value]) => ({ name, value })),
      resources: { limits: {}, requests: {} },
      volumeMounts,
    },
    podVolumes,
  };
}

/**
 * The three annotations Prometheus's pod service discovery relabels on. Kept as
 * one function so the key names and the "/metrics" default live in exactly one
 * place — a workload declares intent (`scrape: { port }`), never the strings.
 */
function scrapeAnnotations(scrape: WorkloadSpec["scrape"]): Record<string, string> | undefined {
  if (!scrape) return undefined;
  return {
    "prometheus.io/scrape": "true",
    "prometheus.io/port": String(scrape.port),
    "prometheus.io/path": scrape.path ?? "/metrics",
  };
}

/**
 * A workload that mounts a pre-existing `claim:` PVC cannot roll: those claims
 * are block volumes on the local-lvm CSI (ReadWriteOnce), so the surge pod's
 * mount is refused while the outgoing pod still holds the device and the
 * rollout deadlocks until the deploy times out (#300 broke prod this way — the
 * `maps` claim under web's map-provision init). Volumes this module generates
 * itself are NFS/ReadWriteMany and roll fine, so only declared claims count.
 */
function mountsExistingClaim(w: WorkloadSpec): boolean {
  const declared = [
    ...(w.volumes ?? []),
    ...(w.initContainers ?? []).flatMap((i) => i.volumes ?? []),
  ];
  return declared.some((v) => v.claim && !v.nfs);
}

function legacyAliases(name: string | undefined): pulumi.Alias[] | undefined {
  return name ? [{ name }] : undefined;
}

export function renderWorkload(w: WorkloadSpec): RenderedWorkload {
  const labels = { app: w.name };
  const { container, podVolumes, persistentVolumes, persistentVolumeClaims } = buildPod(w);
  const claimVolumeNames = new Map(
    podVolumes.flatMap((v) =>
      v.persistentVolumeClaim ? [[v.persistentVolumeClaim.claimName, v.name] as const] : [],
    ),
  );
  const inits = (w.initContainers ?? []).map((ic, i) =>
    buildInitContainer(ic, i, claimVolumeNames),
  );
  const podAnnotations = scrapeAnnotations(w.scrape);

  const deployment: DeploymentArgs = {
    metadata: {
      name: w.name,
      labels,
      ...(w.annotations && Object.keys(w.annotations).length > 0
        ? { annotations: w.annotations }
        : {}),
    },
    spec: {
      replicas: w.replicas,
      selector: { matchLabels: labels },
      // rollingUpdate is explicitly null, not omitted: the API server defaults
      // that block onto every existing Deployment, and it survives the patch —
      // leaving `type: Recreate` alongside a rollingUpdate stanza, which the
      // API server rejects ("may not be specified when strategy `type` is
      // 'Recreate'"). Null deletes it in the same apply.
      ...(mountsExistingClaim(w)
        ? { strategy: { type: "Recreate" as const, rollingUpdate: null } }
        : {}),
      template: {
        metadata: { labels, ...(podAnnotations ? { annotations: podAnnotations } : {}) },
        spec: {
          containers: [container],
          ...(inits.length > 0 ? { initContainers: inits.map((i) => i.container) } : {}),
          volumes: [...podVolumes, ...inits.flatMap((i) => i.podVolumes)],
          ...(w.imagePullSecrets && w.imagePullSecrets.length > 0
            ? { imagePullSecrets: w.imagePullSecrets.map((name) => ({ name })) }
            : {}),
          automountServiceAccountToken: false,
          ...(w.hostNetwork ? { hostNetwork: true } : {}),
          ...(w.dnsPolicy ? { dnsPolicy: w.dnsPolicy } : {}),
          ...(w.runtimeClassName ? { runtimeClassName: w.runtimeClassName } : {}),
        },
      },
    },
  };

  const services: ServiceArgs[] = [];
  const exposed = (w.ports ?? []).filter((p) => p.expose !== "none");
  if (exposed.length > 0) {
    const type = exposed.some((p) => p.expose === "lan") ? "LoadBalancer" : "ClusterIP";
    services.push({
      metadata: { name: w.name, labels },
      spec: {
        type,
        selector: labels,
        // Only meaningful on a LoadBalancer; a ClusterIP Service rejects it.
        ...(type === "LoadBalancer" && w.loadBalancerIp
          ? { loadBalancerIP: w.loadBalancerIp }
          : {}),
        ports: exposed.map((p) => ({
          name: `p${p.containerPort}`,
          port: p.containerPort,
          targetPort: p.containerPort,
        })),
      },
    });
  }

  return { deployment, services, persistentVolumes, persistentVolumeClaims };
}

export function renderCronJob(c: CronJobSpec): RenderedCronJob {
  const labels = { app: c.name };
  const { container, podVolumes, persistentVolumes, persistentVolumeClaims } = buildPod(c);

  const cronJob: CronJobArgs = {
    metadata: { name: c.name, labels },
    spec: {
      schedule: c.schedule,
      suspend: c.suspend ?? false,
      concurrencyPolicy: "Forbid",
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 1,
      jobTemplate: {
        spec: {
          ...(c.activeDeadlineSeconds !== undefined
            ? { activeDeadlineSeconds: c.activeDeadlineSeconds }
            : {}),
          template: {
            metadata: { labels },
            spec: {
              containers: [container],
              volumes: podVolumes,
              restartPolicy: "Never",
              automountServiceAccountToken: false,
              ...(c.imagePullSecrets && c.imagePullSecrets.length > 0
                ? { imagePullSecrets: c.imagePullSecrets.map((name) => ({ name })) }
                : {}),
            },
          },
        },
      },
    },
  };

  return { cronJob, persistentVolumes, persistentVolumeClaims };
}

export function renderExternalService(name: string, externalName: string): RenderedExternalService {
  return {
    service: {
      metadata: { name, labels: { app: name } },
      spec: { type: "ExternalName", externalName },
    },
  };
}

// ──────────────────────────────────────────────
// ComponentResource classes (formerly component.ts)
// ──────────────────────────────────────────────

/** @public */
export interface WorkloadArgs extends WorkloadSpec {
  provider: k8s.Provider;
  namespace: pulumi.Input<string>;
}

/** @public */
export class Workload extends pulumi.ComponentResource {
  readonly deployment: k8s.apps.v1.Deployment;
  readonly services: k8s.core.v1.Service[];
  readonly persistentVolumes: k8s.core.v1.PersistentVolume[];
  readonly persistentVolumeClaims: k8s.core.v1.PersistentVolumeClaim[];

  constructor(args: WorkloadArgs, opts?: pulumi.ComponentResourceOptions) {
    const { provider, namespace, ...spec } = args;
    const logicalName = spec.logicalName ?? spec.name;
    const aliases = spec.legacyLogicalName
      ? [...(opts?.aliases ?? []), { name: spec.legacyLogicalName }]
      : opts?.aliases;
    super("control-center:infra:Workload", logicalName, {}, { ...opts, aliases });

    const rendered = renderWorkload(spec);
    const childOpts: pulumi.ComponentResourceOptions = { parent: this, provider };
    const pvOpts = { ...childOpts, deleteBeforeReplace: true };
    const serviceOpts = { ...childOpts, deleteBeforeReplace: true };

    this.persistentVolumes = rendered.persistentVolumes.map(
      (pv) => new k8s.core.v1.PersistentVolume(pv.metadata.name, pv as never, pvOpts),
    );
    this.persistentVolumeClaims = rendered.persistentVolumeClaims.map(
      (pvc) =>
        new k8s.core.v1.PersistentVolumeClaim(
          `${logicalName}-${pvc.metadata.name}`,
          { metadata: { namespace, ...pvc.metadata }, spec: pvc.spec as never },
          { ...pvOpts, aliases: legacyAliases(pvc.metadata.name) },
        ),
    );

    this.deployment = new k8s.apps.v1.Deployment(
      logicalName,
      {
        metadata: { namespace, ...rendered.deployment.metadata },
        spec: rendered.deployment.spec as never,
      },
      { ...childOpts, aliases: legacyAliases(spec.legacyLogicalName) },
    );

    this.services = rendered.services.map(
      (svc) =>
        new k8s.core.v1.Service(
          `${logicalName}-${svc.metadata.name}`,
          { metadata: { namespace, ...svc.metadata }, spec: svc.spec as never },
          { ...serviceOpts, aliases: legacyAliases(spec.legacyLogicalName) },
        ),
    );

    this.registerOutputs({
      deployment: this.deployment.id,
      services: this.services.map((s) => s.id),
    });
  }
}

export interface ExternalServiceArgs {
  name: string;
  externalName: string;
  provider: k8s.Provider;
  namespace: pulumi.Input<string>;
}

/** @public */
export class ExternalService extends pulumi.ComponentResource {
  readonly service: k8s.core.v1.Service;

  constructor(args: ExternalServiceArgs, opts?: pulumi.ComponentResourceOptions) {
    super("control-center:infra:ExternalService", args.name, {}, opts);
    const rendered = renderExternalService(args.name, args.externalName);
    const childOpts: pulumi.ComponentResourceOptions = { parent: this, provider: args.provider };

    this.service = new k8s.core.v1.Service(
      args.name,
      {
        metadata: { namespace: args.namespace, ...rendered.service.metadata },
        spec: rendered.service.spec as never,
      },
      childOpts,
    );
    this.registerOutputs({ service: this.service.id });
  }
}

export interface HostBackedServiceArgs {
  // Service (and in-cluster DNS) name.
  name: string;
  // The fixed off-cluster / host endpoint IP the Service fronts (e.g. a
  // hostNetwork pod bound on the node's LAN IP).
  hostIp: string;
  port: number;
  // Shared port name across the Service and its EndpointSlice — the two MUST
  // match by name or kube-proxy ignores the endpoint. Defaults to "http"
  // (HA's :8123 is plain HTTP).
  portName?: string;
  provider: k8s.Provider;
  namespace: pulumi.Input<string>;
}

/**
 * A stable in-cluster ClusterIP Service whose endpoints are a FIXED host IP,
 * supplied via a manually-managed EndpointSlice rather than a pod selector.
 *
 * The canonical use: reaching a `hostNetwork` workload that lives in ANOTHER
 * namespace. A selector Service only matches pods in its own namespace, and a
 * hostNetwork pod's endpoint IP is the node IP anyway, so cross-namespace
 * access is expressed as "Service in front of the node's LAN IP:port".
 *
 * Why not `ExternalService` (ExternalName): an ExternalName Service is a CNAME,
 * valid only to a DNS NAME, never a bare IP — `ha -> 192.168.0.5` makes kube-dns
 * hand back the IP verbatim and callers get `bad address 'ha:8123'`. A
 * selector-less ClusterIP + manual EndpointSlice is the upstream-documented
 * idiom for "a Service pointing at a fixed IP".
 *
 * @public - the talos-substrate shape of the `ha` Service (services.ts); on
 * "orbstack" the host is reached by a tailnet FQDN, so {@link ExternalService}
 * (a valid CNAME target) is used there instead.
 */
export class HostBackedService extends pulumi.ComponentResource {
  readonly service: k8s.core.v1.Service;
  readonly endpointSlice: k8s.discovery.v1.EndpointSlice;

  constructor(args: HostBackedServiceArgs, opts?: pulumi.ComponentResourceOptions) {
    super("control-center:infra:HostBackedService", args.name, {}, opts);
    const { name, hostIp, port, portName = "http", provider, namespace } = args;
    const childOpts: pulumi.ComponentResourceOptions = { parent: this, provider };

    this.service = new k8s.core.v1.Service(
      name,
      {
        metadata: { name, namespace, labels: { app: name } },
        spec: {
          type: "ClusterIP",
          // No selector: endpoints come from the EndpointSlice below, not from
          // a pod-label match (the target pod is in another namespace).
          ports: [{ name: portName, port, targetPort: port, protocol: "TCP" }],
        },
      },
      childOpts,
    );

    // Manual EndpointSlice, associated to the Service by the well-known
    // `kubernetes.io/service-name` label. The `-manual` suffix marks it as NOT
    // endpoint-controller-managed (there is no selector to reconcile from), so
    // the controller leaves it alone.
    this.endpointSlice = new k8s.discovery.v1.EndpointSlice(
      `${name}-manual`,
      {
        metadata: {
          name: `${name}-manual`,
          namespace,
          labels: { "kubernetes.io/service-name": name },
        },
        addressType: "IPv4",
        endpoints: [{ addresses: [hostIp], conditions: { ready: true } }],
        ports: [{ name: portName, port, protocol: "TCP" }],
      },
      childOpts,
    );

    this.registerOutputs({
      service: this.service.id,
      endpointSlice: this.endpointSlice.id,
    });
  }
}

/** @public */
export interface ScheduledJobArgs extends CronJobSpec {
  provider: k8s.Provider;
  namespace: pulumi.Input<string>;
}

/** @public */
export class ScheduledJob extends pulumi.ComponentResource {
  readonly cronJob: k8s.batch.v1.CronJob;
  readonly persistentVolumes: k8s.core.v1.PersistentVolume[];
  readonly persistentVolumeClaims: k8s.core.v1.PersistentVolumeClaim[];

  constructor(args: ScheduledJobArgs, opts?: pulumi.ComponentResourceOptions) {
    const { provider, namespace, ...spec } = args;
    const logicalName = spec.logicalName ?? spec.name;
    const aliases = spec.legacyLogicalName
      ? [...(opts?.aliases ?? []), { name: spec.legacyLogicalName }]
      : opts?.aliases;
    super("control-center:infra:ScheduledJob", logicalName, {}, { ...opts, aliases });

    const rendered = renderCronJob(spec);
    const childOpts: pulumi.ComponentResourceOptions = { parent: this, provider };
    const pvOpts = { ...childOpts, deleteBeforeReplace: true };

    this.persistentVolumes = rendered.persistentVolumes.map(
      (pv) => new k8s.core.v1.PersistentVolume(pv.metadata.name, pv as never, pvOpts),
    );
    this.persistentVolumeClaims = rendered.persistentVolumeClaims.map(
      (pvc) =>
        new k8s.core.v1.PersistentVolumeClaim(
          `${logicalName}-${pvc.metadata.name}`,
          { metadata: { namespace, ...pvc.metadata }, spec: pvc.spec as never },
          { ...pvOpts, aliases: legacyAliases(pvc.metadata.name) },
        ),
    );

    this.cronJob = new k8s.batch.v1.CronJob(
      logicalName,
      {
        metadata: { namespace, ...rendered.cronJob.metadata },
        spec: rendered.cronJob.spec as never,
      },
      { ...childOpts, aliases: legacyAliases(spec.legacyLogicalName) },
    );

    this.registerOutputs({ cronJob: this.cronJob.id });
  }
}
