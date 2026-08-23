// The control-center app workloads on k3s (www-j934.6): the Pulumi-era successor
// to deploy.config.ts's service() declarations. Each is a WorkloadSpec fed to
// the Workload component; secrets come from product-derived service Secrets
// (www-j934.4), images from GHCR via an imagePullSecret, caps are the www-ke9a
// values verbatim. postgres is CNPG (www-j934.5), not here.
//
// The media pipeline (playlist poller, ingest queue, NAS media mount) lives in
// the worker workload: media-worker was merged into it, so there is one worker
// deployable rather than a second, permanently-parked one.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { controlCenterProductManifest, defineProduct, type ProductSlug } from "@www/platform";
import { DEFAULT_METRICS_PORT } from "@www/platform/metrics/port";
import { CLOUDFLARED_WORKLOAD_NAME, type InfraNamespaceName } from "./cluster.ts";
import type { WorkloadSpec } from "./component.ts";
import { ExternalService, HostBackedService, Workload } from "./component.ts";
import { DONT_TEXT_YOUR_EX_IMAGE_DIGEST_KEYS } from "./dont-text-your-ex.ts";
import { GHCR_PULL_SECRET_NAME, GHCR_PULL_SECRET_NAMESPACES } from "./ghcr-pull-secrets.ts";
import { LAN_SERVICE_IPS } from "./metallb.ts";
import { NVIDIA_RUNTIME_CLASS_NAME } from "./nvidia.ts";
import { SERVICE_SECRET_TARGETS, SERVICE_SECRETS, type ServiceSecretName } from "./secrets-map.ts";

// Per-service GHCR image digest map, name -> "sha256:…", set by the CI deploy job
// (`pulumi config set --path imageDigests.<svc>`). A pinned digest renders the
// image as @sha256:… so only the workloads whose digest changed roll on a
// `pulumi up` (the www-czg digest-pin property, now driven by Pulumi config).
// Empty only in non-prod local/dev applies, where :main is fine.
export type ImageDigests = Record<string, string>;
export type OwnedWorkloadSpec = WorkloadSpec & { namespaceName: InfraNamespaceName };

const controlCenterProduct = defineProduct("control-center");
const softwareFactoryProduct = defineProduct("software-factory");
type StandaloneSoftwareFactoryComponent =
  | "api"
  | "blobs"
  | "codec"
  | "console"
  | "relay"
  | "run-worker"
  | "worker";

const standaloneSoftwareFactoryRepository = (
  component: StandaloneSoftwareFactoryComponent,
): string => `ghcr.io/0x63616c/software-factory-${component}`;

const IMAGE_REPOSITORIES = {
  api: {
    product: "control-center",
    digestKey: controlCenterProduct.imageDigestKey("api"),
    repository: controlCenterProduct.imageRepository("api"),
  },
  worker: {
    product: "control-center",
    digestKey: controlCenterProduct.imageDigestKey("worker"),
    repository: controlCenterProduct.imageRepository("worker"),
  },
  web: {
    product: "control-center",
    digestKey: controlCenterProduct.imageDigestKey("web"),
    repository: controlCenterProduct.imageRepository("web"),
  },
  // manage (apps/manage, ADR-0010): a static nginx bundle, same shape as web.
  manage: {
    product: "control-center",
    digestKey: controlCenterProduct.imageDigestKey("manage"),
    repository: controlCenterProduct.imageRepository("manage"),
  },
  "map-provision": {
    product: "control-center",
    digestKey: controlCenterProduct.imageDigestKey("map-provision"),
    repository: controlCenterProduct.imageRepository("map-provision"),
  },
  // The Temporal worker (apps/temporal-worker). Deployed by temporal.ts into
  // its own namespace, but the image is a control-center product component like
  // any other, so it pins through the SAME digest map — one place where "what
  // does CI build and pin" is answered.
  "temporal-worker": {
    product: "control-center",
    digestKey: controlCenterProduct.imageDigestKey("temporal-worker"),
    repository: controlCenterProduct.imageRepository("temporal-worker"),
  },
  // Software Factory is now released by its standalone repository. Keep the
  // existing Pulumi digest keys so the deployment interface stays stable, but
  // render the producer-owned GHCR repositories instead of WWW's retired
  // `www-software-factory-*` image family.
  //
  // `relay` is the separately deployed platform webhook edge, but shares this product
  // image/digest registry so CI pins every Go module image together.
  "software-factory-worker": {
    product: "software-factory",
    digestKey: softwareFactoryProduct.imageDigestKey("worker"),
    repository: standaloneSoftwareFactoryRepository("worker"),
  },
  "software-factory-run-worker": {
    product: "software-factory",
    digestKey: softwareFactoryProduct.imageDigestKey("run-worker"),
    repository: standaloneSoftwareFactoryRepository("run-worker"),
  },
  "software-factory-relay": {
    product: "software-factory",
    digestKey: softwareFactoryProduct.imageDigestKey("relay"),
    repository: standaloneSoftwareFactoryRepository("relay"),
  },
  "software-factory-api": {
    product: "software-factory",
    digestKey: softwareFactoryProduct.imageDigestKey("api"),
    repository: standaloneSoftwareFactoryRepository("api"),
  },
  "software-factory-console": {
    product: "software-factory",
    digestKey: softwareFactoryProduct.imageDigestKey("console"),
    repository: standaloneSoftwareFactoryRepository("console"),
  },
  "software-factory-blobs": {
    product: "software-factory",
    digestKey: softwareFactoryProduct.imageDigestKey("blobs"),
    repository: standaloneSoftwareFactoryRepository("blobs"),
  },
  "software-factory-codec": {
    product: "software-factory",
    digestKey: softwareFactoryProduct.imageDigestKey("codec"),
    repository: standaloneSoftwareFactoryRepository("codec"),
  },
} as const satisfies Record<
  string,
  { product: ProductSlug; digestKey: string; repository: string }
>;

const IMAGE_DIGEST_KEYS = new Set([
  ...Object.values(IMAGE_REPOSITORIES).map((image) => image.digestKey),
  ...DONT_TEXT_YOUR_EX_IMAGE_DIGEST_KEYS,
]);
/**
 * The digest keys belonging to one product.
 *
 * Required pins are asked for PER PRODUCT, not across the whole map. serviceSpecs
 * renders control-center's workloads and nothing else, so demanding
 * software-factory's pins there would let a broken sandbox build block the
 * house's own deploy — a coupling between two products that share nothing but a
 * registry. Each renderer asserts the pins it actually needs.
 *
 * `imageDigestKey` is `${slug}-${component}`, so the prefix is the product.
 */
/**
 * @public - the digest keys one product owns, from a table of images.
 *
 * Ownership is DECLARED on each entry, never inferred from a key's spelling. A
 * `startsWith(`${slug}-`)` test reads as exact and silently over-matches the
 * day one slug prefixes another — "control-center" would swallow a future
 * "control-center-edge" and quietly widen what a prod deploy demands. Putting
 * the prefix on the repository name instead has the identical bug.
 *
 * It takes the table as an argument rather than closing over IMAGE_REPOSITORIES
 * so the difference is TESTABLE: with only today's mutually non-prefixing
 * slugs, an equality filter and a prefix filter behave identically, and the
 * improvement would be unfalsifiable closed over the live table.
 */
export function keysOwnedBy<T extends { product: string; digestKey: string }>(
  images: readonly T[],
  slug: string,
): string[] {
  return images.filter((image) => image.product === slug).map((image) => image.digestKey);
}

function digestKeysFor(slug: ProductSlug): string[] {
  return keysOwnedBy(Object.values(IMAGE_REPOSITORIES), slug);
}

const REQUIRED_IMAGE_DIGEST_KEYS = digestKeysFor("control-center");

/**
 * @public - asserts that every image this product ships is digest-pinned.
 *
 * For renderers outside serviceSpecs (software-factory.ts) that must not render
 * a mutable `:main` ref on a production cluster either.
 */
export function assertImageDigestPins(slug: ProductSlug, digests: ImageDigests): void {
  const missing = digestKeysFor(slug).filter((key) => !digests[key]);
  if (missing.length > 0) {
    throw new Error(
      `prod stack requires wwwinfra:imageDigests pins for ${slug} images; missing: ${missing.join(", ")}`,
    );
  }
}

function validateImageDigests(digests: ImageDigests): void {
  for (const key of Object.keys(digests)) {
    if (!IMAGE_DIGEST_KEYS.has(key)) {
      throw new Error(`imageDigests.${key} is not a known product-component image key`);
    }
  }
}

function validateRequiredImageDigests(digests: ImageDigests): void {
  const missing = REQUIRED_IMAGE_DIGEST_KEYS.filter((key) => !digests[key]);
  if (missing.length > 0) {
    throw new Error(
      `prod stack requires wwwinfra:imageDigests pins for app images; missing: ${missing.join(
        ", ",
      )}`,
    );
  }
}

// Stacks that manage a real production cluster: app Deployments must NOT render
// mutable :main images there (an incomplete CI digest map is a hard error, not a
// silent :main fallback). "prod" is the retired mini; "home-server" is the live
// Talos cluster CI now deploys to.
const PROD_LIKE_STACKS = new Set(["prod", "home-server"]);

export function shouldRequireImageDigestPins(stackName: string): boolean {
  return PROD_LIKE_STACKS.has(stackName);
}

// GHCR image ref. Digest-pinned (@sha256:…) when CI supplied a digest for this
// service, else the mutable :main tag (local applies, first deploy before any
// digest is set). The digest is validated shape-wise so a malformed config value
// can't silently produce an unpullable ref.
export const ghcrImage = (name: string, digests: ImageDigests = {}): string => {
  const image = IMAGE_REPOSITORIES[name as keyof typeof IMAGE_REPOSITORIES];
  if (!image) throw new Error(`no image repository configured for ${name}`);
  const digest = digests[image.digestKey];
  if (digest) {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`imageDigests.${image.digestKey} is not a sha256:<64-hex> digest: ${digest}`);
    }
    return `${image.repository}@${digest}`;
  }
  return `${image.repository}:main`;
};
// The imagePullSecret name (dockerconfigjson built by ESO from the GHCR token).
// HA is reached via the host's TAILSCALE FQDN, NOT the LAN IP (www-j934.17):
// OrbStack k8s pods can't route to 192.168.0.0/24 or raw host ports, but the
// Mac locally routes its OWN tailnet IP (utun) to its 0.0.0.0-bound socats, so
// homelab.tail8c014d.ts.net:8123 is delivered to the existing HA socat. The
// `ha` ExternalName Service CNAMEs to this; api/worker keep using http://ha:8123.
const HA_TAILNET_FQDN = "homelab.tail8c014d.ts.net";
const HA_PORT = 8123;

// The two homelab substrates this program can target: "orbstack" is the
// currently-live Mac mini (arm64, OrbStack k3s) and is the DEFAULT everywhere
// below so an omitted `wwwinfra:substrate` config renders byte-identical mini
// output; "talos" is the Talos cluster on the gaming PC (amd64) migration
// target. Never add a third value without re-auditing every haTarget/
// plexAdvertiseIp call site.
export type Substrate = "orbstack" | "talos";

/**
 * Boundary-validates the raw `wwwinfra:substrate` Pulumi config string (or
 * undefined) into a {@link Substrate}. Missing config = "orbstack" (the mini),
 * preserving today's live-deploy behavior exactly; any value other than the
 * two known substrates is a hard config error, not a silent fallback.
 *
 * @public - unit-tested in infra/test/services.test.ts.
 */
export function parseSubstrate(value: string | undefined): Substrate {
  if (value === undefined || value === "orbstack") return "orbstack";
  if (value === "talos") return "talos";
  throw new Error(`wwwinfra:substrate must be "orbstack" or "talos", got "${value}"`);
}

// Task 3 shipped haTarget/plexAdvertiseIp as `(substrate: Substrate, nodeIp:
// string)`, with nodeIp defaulting to "" on orbstack — a representable-but-
// meaningless state (an empty nodeIp could in principle reach the "talos"
// branch of a future call site and silently render `http://:32400`). Task 4's
// deferred cleanup: nodeIp only EXISTS on the "talos" variant, so a talos code
// path with no nodeIp is a compile error, not a runtime footgun.
export type SubstrateTarget =
  | { readonly substrate: "talos"; readonly nodeIp: string }
  | { readonly substrate: "orbstack" };

// The Talos node's static LAN IP (locked decision), used when talos is
// selected but no explicit `wwwinfra:nodeIp` override is configured.
const DEFAULT_TALOS_NODE_IP = "192.168.0.5";

/**
 * Boundary-validates the raw `wwwinfra:substrate` + `wwwinfra:nodeIp` Pulumi
 * config strings into a {@link SubstrateTarget}. This is the ONLY place a
 * nodeIp is attached to a substrate; every other function in this module
 * takes the already-validated union, so "talos with no nodeIp" cannot occur
 * downstream.
 *
 * @public - unit-tested in infra/test/services.test.ts; consumed by program.ts.
 */
export function parseSubstrateTarget(
  substrateValue: string | undefined,
  nodeIpValue: string | undefined,
): SubstrateTarget {
  const substrate = parseSubstrate(substrateValue);
  if (substrate === "orbstack") return { substrate: "orbstack" };
  return {
    substrate: "talos",
    nodeIp: nodeIpValue && nodeIpValue.length > 0 ? nodeIpValue : DEFAULT_TALOS_NODE_IP,
  };
}

// Mini (orbstack) values below are frozen: they are the CURRENT LIVE prod
// values and must never change as a side effect of this file. The talos
// counterparts route through the node's LAN IP instead (see haTarget /
// plexAdvertiseIp).
const MINI_PLEX_ADVERTISE_IP = "http://192.168.0.147:32400";
const PLEX_PORT = 32400;

/**
 * The `ha` ExternalName Service target (www-j934.17). On "orbstack" (the mini,
 * default) this is unconditionally the host's tailnet FQDN: OrbStack pods
 * can't route to the LAN, but the Mac locally routes its own tailnet IP to the
 * host HA socat (see the HA_TAILNET_FQDN comment above). On "talos", api/
 * worker are ordinary (non-hostNetwork) pods, so they can't reach a
 * hostNetwork HA via loopback — HA binds :8123 in the *node's* netns, which is
 * reachable from any pod at the node's LAN IP.
 *
 * @public - unit-tested in infra/test/services.test.ts; consumed by
 * deployServices below and by Task 4.
 */
export function haTarget(target: SubstrateTarget): string {
  return target.substrate === "talos" ? target.nodeIp : HA_TAILNET_FQDN;
}

/**
 * Plex's `ADVERTISE_IP` env var: the externally-reachable URL Plex advertises
 * to clients (e.g. the Apple TV). On "orbstack" (the mini, default) this is
 * the Mac's LAN IP, republished on the host by OrbStack's expose_services. On
 * "talos" this is Plex's own MetalLB LoadBalancer address (LAN_SERVICE_IPS),
 * NOT the node IP: nothing listens on :32400 in the node's netns, so a node-IP
 * URL advertises a refused connection and every client that trusts it (the
 * Apple TV) fails to reach the server even though it is healthy.
 *
 * @public - unit-tested in infra/test/services.test.ts; consumed by
 * serviceSpecs below and by Task 4.
 */
export function plexAdvertiseIp(target: SubstrateTarget): string {
  return target.substrate === "talos"
    ? `http://${LAN_SERVICE_IPS.plex}:${PLEX_PORT}`
    : MINI_PLEX_ADVERTISE_IP;
}

const TZ = "America/Los_Angeles";

// The CNPG read-write Service (www-j934.5) the app connects to. env.ts builds
// DATABASE_URL as postgres://postgres:<pw>@$POSTGRES_HOST:5432/control_center;
// the default host "postgres" was the Swarm service name and does NOT resolve in
// k3s, so set it to the CNPG Service explicitly (a live-deploy finding).
const controlCenterDatabase = controlCenterProductManifest().database;
// captivePortalProductManifest() (database/secretUsages) is no longer called
// anywhere in infra/ (Task 4 step C removed the captive-portal-api workload
// that used the secretUsages; Task 6 removed the CNPG cluster + backup
// CronJob that used the database). The function itself still exists in
// @www/platform , pruned in a later platform-cleanup task (7+8).

// go2rtc: the in-cluster RTSP->MJPEG restreamer for the bedroom camera. It runs
// in the control-center namespace as a ClusterIP Service on :1984, and the api
// proxies its MJPEG endpoint at /media/camera-stream. This deliberately does NOT
// go through Home Assistant: the camera is reachable directly over RTSP, so the
// tile stays up when HA is down. Only the RTSP credentials are secret (they ride
// in the composed go2rtc.yaml Secret below); these three are plain env.
const GO2RTC_SERVICE_NAME = "go2rtc";
const GO2RTC_PORT = 1984;
const GO2RTC_CONFIG_SECRET_NAME = "control-center-go2rtc-config";
const GO2RTC_CONFIG_MOUNT_PATH = "/config";
// Pinned tag, never :latest — a mutable upstream tag would silently roll the
// restreamer on every node restart. Not a GHCR image, so no digest pin (an
// unknown key in wwwinfra:imageDigests hard-fails validateImageDigests).
const GO2RTC_IMAGE = "alexxit/go2rtc:1.9.9";
const CAMERA_STREAM_NAME = "bedroom_mjpeg";
const CAMERA_LABEL = "Living Room Cam";

// Shared non-secret env for api + worker (HA reached via the in-cluster `ha`
// Service name now, not host.docker.internal; DB via the CNPG Service).
const haEnv = {
  NODE_ENV: "production",
  APP_ENV: "production",
  TZ,
  HA_URL: `http://ha:${HA_PORT}`,
  UNIFI_CONTROLLER_URL: "https://192.168.0.1",
  POSTGRES_HOST: controlCenterDatabase.rwServiceName,
  GO2RTC_URL: `http://${GO2RTC_SERVICE_NAME}:${GO2RTC_PORT}`,
  CAMERA_STREAM_NAME,
  CAMERA_LABEL,
};

// A marker list so the Workload mounts its configured service Secret; the actual
// key -> vault-key mapping lives in SERVICE_SECRETS (derived from the platform
// manifest). The render layer only reads .length to decide whether to attach the
// /run/secrets volume, so we derive the names straight from SERVICE_SECRETS and
// this list can never drift from what eso.ts actually syncs.
const mountSecrets = (service: ServiceSecretName) =>
  Object.keys(SERVICE_SECRETS[service]).map((name) => ({ name, ref: "eso" }));

/**
 * Replica/topology knobs the program threads in at apply time.
 * - cloudflaredReplicas: 0 for a pre-cutover bring-up (so the k3s cloudflared does
 *   NOT grab the live tunnel token and split-brain prod with Swarm), flipped to 2
 *   (HA) at the cutover (www-j934.9 / DESIGN §7 step 3).
 * - nasNfsServer: the NFS server address for the media share, the NAS LAN IP by
 *   default. The PV is mounted by kubelet in the node netns, which on home-server (the
 *   prod target) reaches the home LAN directly (DESIGN 5b); the pod-egress no-route
 *   limit (DESIGN 5c) does not apply to PV mounts. www-j934.17.
 * - imageDigests: CI-supplied digest pin map (name -> sha256:…); absent only in
 *   non-prod local applies, where every image falls back to the :main tag. www-j934.14.
 * - requireImageDigestPins: prod safety guard. Refuse to render app Deployments
 *   with mutable/private :main images when wwwinfra:imageDigests is incomplete.
 * - target: which cluster this program targets, {substrate:"orbstack"} (the
 *   mini, default) or {substrate:"talos", nodeIp} (the gaming-PC migration
 *   target). Drives plexAdvertiseIp() below; default preserves the mini's
 *   exact current value. A talos target's nodeIp is REQUIRED by the type (see
 *   {@link SubstrateTarget}), so no call site can reach the talos branch with
 *   a missing/empty nodeIp.
 */
export interface ServiceSpecOptions {
  cloudflaredReplicas: number;
  nasNfsServer: string;
  imageDigests?: ImageDigests;
  requireImageDigestPins?: boolean;
  target?: SubstrateTarget;
}

/** @public - all app WorkloadSpecs, parameterised by {@link ServiceSpecOptions}. */
export function serviceSpecs(opts: ServiceSpecOptions): OwnedWorkloadSpec[] {
  const {
    cloudflaredReplicas,
    nasNfsServer,
    imageDigests: digests = {},
    requireImageDigestPins = false,
    target = { substrate: "orbstack" },
  } = opts;
  validateImageDigests(digests);
  if (requireImageDigestPins) validateRequiredImageDigests(digests);
  return [
    {
      logicalName: "control-center-api",
      legacyLogicalName: "api",
      name: "api",
      namespaceName: "control-center",
      image: ghcrImage("api", digests),
      replicas: 1,
      // 1G, not 512M: the api sits at ~70 MiB steady state but bursts to ~405 MiB
      // for 3-16 minutes at a time (~83% of a 512M limit), so a slightly larger
      // burst would OOM-kill it and take the panel down. Interim headroom while
      // #306 chases the retention that drives the burst , not a fix.
      resources: { memory: "1G", reserveCpus: "0.5" },
      secrets: mountSecrets("api"),
      secretName: SERVICE_SECRET_TARGETS.api.secretName,
      // Wake photos persist on the NAS media share (same NFS export + subPath
      // as the worker); without this mount the api's MEDIA_STORAGE_DIR
      // writes land in the container overlay fs and vanish on every roll.
      env: {
        ...haEnv,
        MEDIA_STORAGE_DIR: "/app/media",
        // Guest (captive-portal) listener cutover (SDD track 0, Task 4). LIVE
        // LAN cutover (this deploy): 443/80, verified dark on 4300/4301 first
        // (TLS wiring + static bundle + portal.* tRPC all checked from inside
        // the cluster). GUEST_HTTP_PORT=80 is required , guest-server.ts's
        // default plain-HTTP companion is port+1, which off 443 would be 444,
        // not the conventional 80 (the k8s Service's exposed port always
        // equals the container port, no remap in the infra WorkloadSpec).
        // The old captive-portal-portal workload's LAN ports are removed in
        // this SAME commit (see below) , both workloads can't hold the LAN
        // 443/80 host ports at once.
        GUEST_PORT: "443",
        GUEST_HTTP_PORT: "80",
        GUEST_STATIC_DIR: "/app/portal-dist",
        GUEST_TLS_DIR: "/certs",
      },
      volumes: [
        {
          mountPath: "/app/media",
          nfs: { server: nasNfsServer, path: "/volume1/Homelab" },
          subPath: "media",
        },
      ],
      ports: [
        { containerPort: 4201, expose: "cluster" },
        // Guest TLS listener (443) + its always-plain-HTTP OS-detection
        // companion (80, via GUEST_HTTP_PORT above). LAN LoadBalancer , the
        // old captive-portal-portal Service (which held this same LAN address
        // + ports) is confirmed deleted live (`kubectl get svc portal` ->
        // NotFound), so nothing else is contending for it now (Task 4 step
        // B2, second retry: the two-Service address handoff needs to be
        // strictly sequential, see the removed-ports comment on the old
        // captive-portal-portal workload below).
        { containerPort: 443, expose: "lan" },
        { containerPort: 80, expose: "lan" },
      ],
      // Pinned on talos: the guest portal is reached by address, and it shares
      // a 2-address MetalLB pool with plex (see LAN_SERVICE_IPS).
      ...(target.substrate === "talos" ? { loadBalancerIp: LAN_SERVICE_IPS.api } : {}),
      // The control-center copy of the portal TLS cert (issuePortalCertificate
      // in certmanager.ts), same rename convention as the old captive-portal
      // workload below (tls.crt/tls.key -> fullchain.pem/key.pem, the acme.sh
      // filenames guest-server.ts expects).
      extraSecretMounts: [
        {
          secretName: "captive-portal-tls",
          mountPath: "/certs",
          items: [
            { key: "tls.crt", path: "fullchain.pem" },
            { key: "tls.key", path: "key.pem" },
          ],
        },
      ],
      imagePullSecrets: [GHCR_PULL_SECRET_NAME],
      // #214. The metrics listener is a SEPARATE port from the 4201 above and
      // is deliberately absent from `ports`: 4201 is what the Cloudflare tunnel
      // maps the public `hooks.` host to, and anything listed in `ports` gets a
      // Service. Prometheus scrapes the pod IP directly off these annotations.
      scrape: { port: DEFAULT_METRICS_PORT },
    },
    {
      logicalName: "control-center-worker",
      legacyLogicalName: "worker",
      name: "worker",
      namespaceName: "control-center",
      image: ghcrImage("worker", digests),
      replicas: 1,
      resources: { memory: "512M" },
      secrets: mountSecrets("worker"),
      secretName: SERVICE_SECRET_TARGETS.worker.secretName,
      env: {
        ...haEnv,
        // Point at the NFS mount below -- the env default (/mnt/media) is the
        // container overlay fs, not the NAS share.
        MEDIA_STORAGE_DIR: "/app/media",
      },
      // NFS PV for the Synology media share. The DS420+ exports ONLY
      // /volume1/Homelab (not its subdirs), so mount that export and subPath
      // into media/. nfsvers=4.0 is enforced by the render layer (the Talos node
      // does in-kernel NFSv4 mounts only; NFSv4 is enabled on the DS420+).
      volumes: [
        {
          mountPath: "/app/media",
          nfs: { server: nasNfsServer, path: "/volume1/Homelab" },
          subPath: "media",
        },
      ],
      imagePullSecrets: [GHCR_PULL_SECRET_NAME],
      // #214: the worker serves no other HTTP, so this is its only listener.
      scrape: { port: DEFAULT_METRICS_PORT },
    },
    {
      logicalName: "control-center-web",
      legacyLogicalName: "web",
      name: "web",
      namespaceName: "control-center",
      image: ghcrImage("web", digests),
      replicas: 1,
      resources: { memory: "96M" },
      env: { TZ },
      ports: [{ containerPort: 80, expose: "cluster" }],
      // maps basemap served from a local PVC (provisioned by the
      // map-provision init below + refreshed by the map-extract CronJob).
      volumes: [{ mountPath: "/usr/share/nginx/html/maps", claim: "maps", readOnly: true }],
      // Basemap self-provisioning (www-hn1i): runs before nginx in if-missing
      // mode (instant no-op when socal.pmtiles exists), so "the basemap is in
      // the PVC" is a structural precondition of serving, a fresh stack
      // self-heals with zero manual steps (the old suspended-manual-job flow
      // shipped prod with an empty PVC and a blank Tesla map).
      initContainers: [
        {
          name: "map-provision",
          image: ghcrImage("map-provision", digests),
          command: ["/provision.sh"],
          volumes: [{ mountPath: "/out", claim: "maps" }],
        },
      ],
      imagePullSecrets: [GHCR_PULL_SECRET_NAME],
    },
    {
      // manage (ADR-0010): the management plane at manage.worldwidewebb.co.
      // Static bundle behind nginx, no api and no database — it holds no
      // credentials of its own, and Cloudflare Access is the only gate.
      logicalName: "control-center-manage",
      name: "manage",
      namespaceName: "control-center",
      image: ghcrImage("manage", digests),
      replicas: 1,
      resources: { memory: "64M" },
      env: { TZ },
      ports: [{ containerPort: 80, expose: "cluster" }],
      imagePullSecrets: [GHCR_PULL_SECRET_NAME],
    },
    // control-center-storybook workload DELETED (Track B, Task 10a): storybook
    // is a local-dev-only tool now, no deploy pipeline, no in-cluster Deployment.
    // captive-portal-portal and captive-portal-api workloads DELETED (Task 4
    // step C, SDD track 0): both were fully dark (zero ports exposed) after
    // step B's LAN cutover moved all guest traffic onto control-center-api.
    // The rest of the product followed: products/captive-portal/ + the
    // "captive-portal"/"captive-portal-api" digestKey entries above (Task 5),
    // then the "captive-portal" namespace, its CNPG Postgres Clusters, and its
    // pg-backup CronJob (Task 6 , the one live guest-authorization row was
    // copied into control_center and a final pg_dump taken to the NAS first).
    // control-center-drizzle workload DELETED: the Drizzle Gateway (self-hosted
    // Studio at drizzle.worldwidewebb.co) was parked at replicas 0 and never
    // brought back; its folder, CF route, Access app, secret and PVC were pruned.
    {
      // Plex Media Server (third-party). Serves the Synology media share to the
      // Apple TV. Not a control-center product component, but co-located in the
      // control-center namespace to reuse the media NFS share + a local PVC.
      logicalName: "control-center-plex",
      name: "plex",
      namespaceName: "control-center",
      // Version-pinned public image (multi-arch; arm64 manifest for the OrbStack
      // node). Third-party like cloudflared: no GHCR pull secret, no digest pin.
      image: "plexinc/pms-docker:1.43.2.10687-563d026ea",
      replicas: 1,
      resources: {
        memory: "1G",
        reserveCpus: "0.5",
        // GPU hardware transcode (Task 4): only the Talos node has a passed-
        // through RTX 3060 + the `nvidia` RuntimeClass; the mini has neither,
        // so this stays undefined (no nvidia.com/gpu limit rendered) on
        // "orbstack" and Plex behaves exactly as it does today.
        ...(target.substrate === "talos" ? { gpu: 1 } : {}),
      },
      // RuntimeClass for GPU device-plugin scheduling (nvidia.ts). Same
      // talos-only gating as the gpu resource above.
      ...(target.substrate === "talos" ? { runtimeClassName: NVIDIA_RUNTIME_CLASS_NAME } : {}),
      // Don't gate the deploy on Plex readiness. On a cold apply the GPU device
      // plugin (nvidia.ts) and Plex are created in the same `pulumi up`, and the
      // node only advertises nvidia.com/gpu a beat after the plugin pod starts —
      // so awaiting Plex could time out racing its own GPU capacity. Plex is a
      // non-critical media server; let it schedule asynchronously onto the GPU.
      ...(target.substrate === "talos" ? { annotations: { "pulumi.com/skipAwait": "true" } } : {}),
      env: {
        TZ,
        HOSTNAME: "Plex",
        // No PLEX_CLAIM: plex.tv/claim tokens expire in ~4 min so none can be
        // pre-stored. The server boots UNCLAIMED; claim it once via the web UI
        // (docs/plex.md). ADVERTISE_IP publishes the substrate's LAN address so
        // clients get a directly-reachable URL, not the in-cluster pod IP: on
        // "orbstack" (default) that's the Mac's LAN IP, republished on the host
        // by OrbStack's expose_services (en0 LAN, update if it changes); on
        // "talos" it's the node's LAN IP with the MetalLB :32400 LoadBalancer.
        ADVERTISE_IP: plexAdvertiseIp(target),
      },
      // Plex config/metadata (SQLite) MUST live on fast local disk, never NFS
      // (SQLite over NFS corrupts). local PVC on the OrbStack SSD.
      // The media share is the same NFS export + subPath as the worker, mounted
      // read-only; point a Plex library at /data (docs/plex.md).
      volumes: [
        { mountPath: "/config", claim: "plex-config" },
        {
          mountPath: "/data",
          nfs: { server: nasNfsServer, path: "/volume1/Homelab" },
          subPath: "media",
          readOnly: true,
        },
      ],
      // LAN LoadBalancer on :32400 (republished on the Mac host by OrbStack
      // expose_services, same mechanism as the captive-portal LB), so the Apple
      // TV on 192.168.0.0/24 reaches Plex directly. On talos the address is
      // pinned, because ADVERTISE_IP above hardcodes it.
      ports: [{ containerPort: 32400, expose: "lan" }],
      ...(target.substrate === "talos" ? { loadBalancerIp: LAN_SERVICE_IPS.plex } : {}),
    },
    {
      // go2rtc restreams the bedroom camera's RTSP feed as MJPEG for the web
      // tile (the browser can't play RTSP). Public Docker Hub image on a pinned
      // tag, so no GHCR pull secret and no digest pin. Its whole config is the
      // composed `control-center-go2rtc-config` Secret (deployServices below),
      // mounted read-only at go2rtc's default config dir /config — the image's
      // own entrypoint then reads /config/go2rtc.yaml, so no `command` override
      // (a k8s `command` REPLACES the entrypoint outright).
      logicalName: "control-center-go2rtc",
      name: GO2RTC_SERVICE_NAME,
      namespaceName: "control-center",
      image: GO2RTC_IMAGE,
      replicas: 1,
      resources: { memory: "256M" },
      env: { TZ },
      ports: [{ containerPort: GO2RTC_PORT, expose: "cluster" }],
      extraSecretMounts: [
        { secretName: GO2RTC_CONFIG_SECRET_NAME, mountPath: GO2RTC_CONFIG_MOUNT_PATH },
      ],
      // Public upstream image; no GHCR pull secret.
    },
    {
      logicalName: "cloudflare-cloudflared",
      legacyLogicalName: "platform-cloudflared",
      name: CLOUDFLARED_WORKLOAD_NAME,
      namespaceName: "cloudflare",
      image: "cloudflare/cloudflared:2025.10.1",
      replicas: cloudflaredReplicas, // HA (2) at cutover; 0 pre-cutover so it
      // does not hold the live tunnel token alongside Swarm (www-j934.9 / §7).
      resources: { memory: "128M", reserveCpus: "0.25" },
      secrets: mountSecrets("cloudflared"),
      secretName: SERVICE_SECRET_TARGETS.cloudflared.secretName,
      // k8s `command` REPLACES the image entrypoint (unlike Swarm, which appends
      // to it), so the binary `cloudflared` must lead, then its `tunnel ...` args.
      command: [
        "cloudflared",
        "tunnel",
        "--no-autoupdate",
        "run",
        "--token-file",
        "/run/secrets/TUNNEL_TOKEN",
      ],
      // Public upstream image; no GHCR pull secret.
    },
  ];
}

export interface ServicesArgs {
  provider: k8s.Provider;
  namespaces: Readonly<Record<InfraNamespaceName, pulumi.Input<string>>>;
  // cloudflared replicas: 0 for a pre-cutover bring-up (no live-token split with
  // Swarm), 2 (HA) at the cutover (www-j934.9 / DESIGN §7).
  cloudflaredReplicas: number;
  // NFS server for the media share: NAS LAN IP by default; kubelet mounts the PV
  // from the node netns, which reaches the LAN on home-server (DESIGN 5b/5c, www-j934.17).
  nasNfsServer: string;
  // Per-service image digest pins from CI (name -> sha256:…); see ghcr().
  imageDigests?: ImageDigests;
  // Prod stack guard against rendering app Deployments with mutable :main images.
  requireImageDigestPins?: boolean;
  // Which cluster this program targets: {substrate:"orbstack"} (the mini,
  // default) or {substrate:"talos", nodeIp} (the migration target). Drives
  // haTarget() below; default preserves the mini's exact current `ha`
  // ExternalName value. See {@link SubstrateTarget} , a talos target always
  // carries its nodeIp, so this can't reach haTarget()'s talos branch empty.
  target?: SubstrateTarget;
  // Decrypted vault from vault.ts (CC-k8t7).
  vault: Record<string, string>;
}

export interface ServicesResources {
  ghcrPullSecrets: k8s.core.v1.Secret[];
  go2rtcConfigSecret: k8s.core.v1.Secret;
  haService: ExternalService | HostBackedService;
  pvcs: k8s.core.v1.PersistentVolumeClaim[];
  workloads: Workload[];
}

// The local (node-SSD) PVCs the workloads mount by claim name: the web basemap
// dir (map-extract, .7, writes into `maps`). Sizes are ENFORCED LVM
// reservations (ADR-0009) — hitting one is an online expansion, not an outage.
const LOCAL_CLAIMS: { name: string; size: string }[] = [
  { name: "maps", size: "5Gi" },
  // Plex config/metadata/thumbnails on the node SSD (SQLite must not be on
  // NFS). Mounted at /config by the plex workload above.
  { name: "plex-config", size: "10Gi" },
];

// The go2rtc config, composed from the vault (the RTSP creds are NOT ESO
// /run/secrets files: go2rtc only reads a config file, so the credentials are
// interpolated into the rtsp:// URL here and the whole file ships as one k8s
// Secret). Username/password are URL-encoded so a `@`, `:` or `/` in the
// password can't break the URL's authority section.
// `bedroom` is the raw RTSP pull; `bedroom_mjpeg` is the ffmpeg transcode the
// browser tile consumes, downscaled to 960px wide (full 1080p MJPEG is ~7 Mbps,
// wasteful for a small tile).
//
// @public - pure YAML assembly, unit-tested in infra/test/services.test.ts.
export function composeGo2rtcConfig(vault: Record<string, string>): string {
  const required = [
    "EUFY_BEDROOM_CAM__HOST",
    "EUFY_BEDROOM_CAM__RTSP_USERNAME",
    "EUFY_BEDROOM_CAM__RTSP_PASSWORD",
    "EUFY_BEDROOM_CAM__RTSP_PATH",
  ] as const;
  for (const key of required) {
    if (!vault[key]) throw new Error(`vault key ${key} not found`);
  }
  const host = vault.EUFY_BEDROOM_CAM__HOST as string;
  const username = encodeURIComponent(vault.EUFY_BEDROOM_CAM__RTSP_USERNAME as string);
  const password = encodeURIComponent(vault.EUFY_BEDROOM_CAM__RTSP_PASSWORD as string);
  const path = (vault.EUFY_BEDROOM_CAM__RTSP_PATH as string).replace(/^\/+/, "");
  const rtspUrl = `rtsp://${username}:${password}@${host}:554/${path}`;
  return [
    "api:",
    `  listen: ":${GO2RTC_PORT}"`,
    "streams:",
    "  bedroom:",
    `    - ${rtspUrl}`,
    `  ${CAMERA_STREAM_NAME}:`,
    "    - ffmpeg:bedroom#video=mjpeg#width=960",
    "log:",
    "  level: info",
    "",
  ].join("\n");
}

// The GHCR org account the imagePullSecret authenticates as (org-owned PAT).
const GHCR_USERNAME = "0x63616c";

// The `.dockerconfigjson` payload for the GHCR imagePullSecret: a docker
// config.json with a single `ghcr.io` auth entry. `auth` is base64("user:pat"),
// which docker/kubelet decode for the registry Basic-auth header (username and
// password are also carried plainly, mirroring what `docker login` writes).
//
// @public - pure JSON assembly, unit-tested in infra/test/services.test.ts.
export function composeGhcrDockerConfigJson(pat: string): string {
  const authB64 = Buffer.from(`${GHCR_USERNAME}:${pat}`).toString("base64");
  return JSON.stringify({
    auths: { "ghcr.io": { username: GHCR_USERNAME, password: pat, auth: authB64 } },
  });
}

/**
 * @public - the GHCR imagePullSecret (ESO dockerconfigjson), the HA headless
 * Service, and every app Workload. Consumed by the cluster program (www-j934.6).
 */
export function deployServices(args: ServicesArgs): ServicesResources {
  const {
    provider,
    namespaces,
    cloudflaredReplicas,
    nasNfsServer,
    imageDigests,
    requireImageDigestPins,
    target = { substrate: "orbstack" },
    vault,
  } = args;
  const opts = { provider };

  // GHCR pull secret: native dockerconfigjson Secret built from the PAT in vault.
  // The token is wrapped in pulumi.secret() so it's encrypted in Pulumi state.
  const pat = vault.GITHUB_PERSONAL_ACCESS_TOKEN__TOKEN;
  if (!pat) throw new Error("vault key GITHUB_PERSONAL_ACCESS_TOKEN__TOKEN not found");
  const dockerconfigjson = composeGhcrDockerConfigJson(pat);
  const ghcrPullSecrets = GHCR_PULL_SECRET_NAMESPACES.map(
    (namespaceName) =>
      new k8s.core.v1.Secret(
        `${namespaceName}-ghcr-pull`,
        {
          metadata: { name: GHCR_PULL_SECRET_NAME, namespace: namespaces[namespaceName] },
          type: "kubernetes.io/dockerconfigjson",
          stringData: { ".dockerconfigjson": pulumi.secret(dockerconfigjson) },
        },
        opts,
      ),
  );

  // go2rtc's whole config (including the camera's RTSP credentials), composed
  // from the vault and shipped as one Secret mounted read-only at /config.
  // pulumi.secret() keeps the RTSP password encrypted in Pulumi state.
  const go2rtcConfigSecret = new k8s.core.v1.Secret(
    GO2RTC_CONFIG_SECRET_NAME,
    {
      metadata: {
        name: GO2RTC_CONFIG_SECRET_NAME,
        namespace: namespaces["control-center"],
      },
      stringData: { "go2rtc.yaml": pulumi.secret(composeGo2rtcConfig(vault)) },
    },
    opts,
  );

  // `ha` -> the HA :8123 endpoint (api/worker reach `http://ha:8123`). The
  // Service SHAPE differs by substrate because the reachable target differs:
  //   - "orbstack" (mini, default): an ExternalName CNAME to the host's tailnet
  //     FQDN (a valid DNS name), delivered to the host HA socat via the
  //     locally-routed tailnet IP (www-j934.17).
  //   - "talos": HA is a hostNetwork pod in the `home-assistant` namespace,
  //     bound on the NODE's LAN IP. A cross-namespace selector Service can't
  //     reach it, and an ExternalName to the bare node IP is an invalid CNAME
  //     (kube-dns hands the IP back and api/worker get `bad address 'ha:8123'`).
  //     So front the fixed node IP with a selector-less ClusterIP + a manual
  //     EndpointSlice (HostBackedService) — the upstream idiom for a Service
  //     over a fixed IP. (Codified from the 2026-07-24 cutover live-patch, which
  //     replaced the malformed ExternalName by hand.)
  const haService =
    target.substrate === "talos"
      ? new HostBackedService(
          {
            name: "ha",
            hostIp: target.nodeIp,
            port: HA_PORT,
            provider,
            namespace: namespaces["control-center"],
          },
          opts,
        )
      : new ExternalService(
          {
            name: "ha",
            externalName: haTarget(target),
            provider,
            namespace: namespaces["control-center"],
          },
          opts,
        );

  // Local PVCs the workloads mount by claim name (web maps).
  const pvcs = LOCAL_CLAIMS.map(
    (c) =>
      new k8s.core.v1.PersistentVolumeClaim(
        c.name,
        {
          metadata: { name: c.name, namespace: namespaces["control-center"] },
          spec: {
            accessModes: ["ReadWriteOnce"],
            storageClassName: "local-lvm",
            resources: { requests: { storage: c.size } },
          },
        },
        opts,
      ),
  );

  const workloads = serviceSpecs({
    cloudflaredReplicas,
    nasNfsServer,
    imageDigests,
    requireImageDigestPins,
    target,
  }).map(
    ({ namespaceName, ...spec }) =>
      new Workload(
        { ...spec, provider, namespace: namespaces[namespaceName] },
        // go2rtc can't start until its config Secret exists (the pod would sit in
        // ContainerCreating on the missing volume), so order it after the Secret.
        spec.name === GO2RTC_SERVICE_NAME ? { ...opts, dependsOn: [go2rtcConfigSecret] } : opts,
      ),
  );

  return { ghcrPullSecrets, go2rtcConfigSecret, haService, pvcs, workloads };
}
