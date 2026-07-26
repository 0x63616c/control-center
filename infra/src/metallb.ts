// MetalLB (Task 4, Talos migration): OrbStack synthesizes `type: LoadBalancer`
// Services for free (its own `expose_services` host-port republishing, see
// services.ts's ADVERTISE_IP comments) , bare-metal Talos has no cloud
// controller to satisfy a LoadBalancer Service, so `api`/`plex` (the two LAN
// LoadBalancers in services.ts) would sit in <pending> forever without an L2
// LB implementation. MetalLB is that implementation: an L2Advertisement makes
// the node itself answer ARP for the pool's addresses via its own NIC.
//
// Namespace `metallb-system` is created BY the pinned upstream manifest itself
// (L1: not threaded through cluster.ts's closed InfraNamespaceName map, same
// pattern as local-path.ts/homeassistant.ts).
//
// TALOS-ONLY: never installed on "orbstack" (the mini's LoadBalancers are
// already satisfied by OrbStack itself; MetalLB would double-advertise the
// same addresses). Gated in program.ts behind `substrate === "talos"`.

import * as k8s from "@pulumi/kubernetes";

const METALLB_NAMESPACE = "metallb-system";
const ADDRESS_POOL_NAME = "homelab-pool";

// Locked decision (M3): a single reserved LAN range for every MetalLB
// LoadBalancer this cluster creates today (`api` + `plex`, 2 addresses
// suffices with headroom for one more before this needs revisiting).
export const METALLB_ADDRESS_POOL_RANGE = "192.168.0.3-192.168.0.4";

export interface MetallbArgs {
  provider: k8s.Provider;
  // Pinned operator manifest version (a git tag in the upstream repo, e.g. "v0.14.9").
  version: string;
}

export interface MetallbResources {
  operator: k8s.yaml.ConfigFile;
  addressPool: k8s.apiextensions.CustomResource;
  l2Advertisement: k8s.apiextensions.CustomResource;
}

/** The speaker flag that makes L2 announcement work on a single control-plane node. */
export const IGNORE_EXCLUDE_LB_FLAG = "--ignore-exclude-lb";

// The subset of an upstream manifest object this transformation touches.
type SpeakerDaemonSetShape = {
  kind?: string;
  metadata?: { name?: string };
  spec?: { template?: { spec?: { containers?: { name?: string; args?: string[] }[] } } };
};

/**
 * @public - exported for the unit test. Appends `--ignore-exclude-lb` to the
 * upstream speaker DaemonSet's args, in place, leaving every other object in the
 * manifest untouched.
 *
 * WHY: Talos labels its control-plane nodes
 * `node.kubernetes.io/exclude-from-external-load-balancers`, and MetalLB's
 * speaker honours that label by refusing to announce LoadBalancer IPs from the
 * node. On a multi-node cluster that is correct (announce from a worker
 * instead). Here there is exactly ONE node and it is the control plane, so the
 * label means NOTHING announces: the speaker creates its ARP responder on
 * enp4s0, then never answers ARP for any pool address. Symptom is both LAN
 * LoadBalancers (`api` on .3, `plex` on .4) resolving to `(incomplete)` in
 * `arp -n` from any LAN host while the Services show healthy endpoints — a
 * silent failure with no error log anywhere.
 *
 * The flag tells the speaker to ignore the label. Preferred over deleting the
 * label from the node: the label is Talos-managed cluster state, and stripping
 * it by hand is exactly the kind of uncodified mutation that drifts back on the
 * next reboot.
 */
export function withIgnoreExcludeLb(obj: SpeakerDaemonSetShape): void {
  if (obj.kind !== "DaemonSet" || obj.metadata?.name !== "speaker") return;
  for (const container of obj.spec?.template?.spec?.containers ?? []) {
    if (container.name !== "speaker") continue;
    const args = container.args ?? [];
    if (!args.includes(IGNORE_EXCLUDE_LB_FLAG)) container.args = [...args, IGNORE_EXCLUDE_LB_FLAG];
  }
}

/**
 * @public - installs the MetalLB operator + a single IPAddressPool +
 * L2Advertisement covering it. Consumed by program.ts, gated to the "talos"
 * substrate.
 */
export function installMetallb(args: MetallbArgs): MetallbResources {
  const { provider, version } = args;
  const opts = { provider };

  // controller + speaker DaemonSet + CRDs + the metallb-system namespace, one
  // manifest (mirrors cert-manager's/local-path's single-ConfigFile install).
  const operator = new k8s.yaml.ConfigFile(
    "metallb-operator",
    {
      file: `https://raw.githubusercontent.com/metallb/metallb/${version}/config/manifests/metallb-native.yaml`,
      // Patch the upstream speaker DaemonSet on the way in rather than forking
      // the manifest, so the pinned upstream URL stays the source of truth.
      transformations: [(obj: SpeakerDaemonSetShape) => withIgnoreExcludeLb(obj)],
    },
    opts,
  );

  const addressPool = new k8s.apiextensions.CustomResource(
    "metallb-address-pool",
    {
      apiVersion: "metallb.io/v1beta1",
      kind: "IPAddressPool",
      metadata: { name: ADDRESS_POOL_NAME, namespace: METALLB_NAMESPACE },
      spec: { addresses: [METALLB_ADDRESS_POOL_RANGE] },
    },
    { ...opts, dependsOn: [operator] },
  );

  // L2 mode (not BGP): a single Talos node has no router peer to speak BGP
  // to, and L2 (gratuitous-ARP) is the documented single-node recipe.
  const l2Advertisement = new k8s.apiextensions.CustomResource(
    "metallb-l2-advertisement",
    {
      apiVersion: "metallb.io/v1beta1",
      kind: "L2Advertisement",
      metadata: { name: "homelab-l2", namespace: METALLB_NAMESPACE },
      spec: { ipAddressPools: [ADDRESS_POOL_NAME] },
    },
    { ...opts, dependsOn: [operator] },
  );

  return { operator, addressPool, l2Advertisement };
}
