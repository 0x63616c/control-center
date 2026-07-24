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
