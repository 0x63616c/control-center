// The k8s Provider + product/platform namespaces for the home-server Talos stack.
// The provider targets the single-node cluster via
// a kubeconfig context. Passing the provider in as an INPUT to every component
// (Workload, ESO, CNPG, …) keeps the vocabulary cluster-agnostic, so a future
// Hetzner cluster is a provider swap, not a rewrite (RECON decision 13 / DESIGN
// section 1).

import * as k8s from "@pulumi/kubernetes";
import type { ProductSlug } from "@www/platform";

export const CLOUDFLARE_NAMESPACE = "cloudflare";
export const CLOUDFLARED_WORKLOAD_NAME = "cloudflared";

// "captive-portal" EXCLUDED (SDD track 0, Task 6): its namespace + CNPG
// clusters + pg-backup CronJob are torn down here. Its @www/platform identity
// (productSlugs, captivePortalProductManifest) deliberately survives a while
// longer (pruned in the later platform-cleanup task, 7+8), so ProductSlug
// itself still includes it , this Exclude is what actually stops a
// "captive-portal" k8s Namespace from being created again.
//
// Software Factory is included because its product-owned CNPG Cluster and
// backup CronJob need the shared namespace map. Captive Portal remains absent:
// its namespace and database were intentionally retired.
export type InfraNamespaceName =
  | Exclude<ProductSlug, "captive-portal">
  | "dont-text-your-ex"
  | typeof CLOUDFLARE_NAMESPACE;
export type InfraNamespaces = Readonly<Record<InfraNamespaceName, k8s.core.v1.Namespace>>;

// Default kubeconfig context. The prod target is the home-server Talos cluster,
// reached over the tailnet via the `home-server` context (server
// home-server.tail8c014d.ts.net:6443). Machine-local staging on a different box
// overrides `wwwinfra:kubeContext` (e.g. a bare `orbstack` context for the
// MacBook's own cluster). CI never relies on this default: it always sets
// `wwwinfra:kubeContext` explicitly from the kubeconfig it writes
// (.github/workflows/ci.yml), so this only matters for an unconfigured local
// `pulumi preview`/`up`. Previously `cc-homelab`, which pointed at the
// Mac mini's OrbStack cluster retired and powered off 2026-07-25 (#24).
const DEFAULT_CONTEXT = "home-server";

export interface ClusterResources {
  provider: k8s.Provider;
  namespaces: InfraNamespaces;
}

/**
 * @public - the cluster provider + product/platform namespaces, the shared base
 * every component builds on. `context` overridable for tests / a future cluster.
 */
// Pin the k8s provider PLUGIN version so a future `pulumi up` can't auto-pull a
// newer plugin that drifts from the @pulumi/kubernetes SDK schema and forces
// state surgery (the v5/v6 footgun, [[pulumi-cloudflare-v5-v6-import-pin]]).
// Matches package.json ^4.21.0. CNPG + cert-manager ride this same provider
// (they install via ConfigFile/Helm), so this pin covers them too.
const K8S_PLUGIN_VERSION = "4.21.0";

export function makeCluster(context: string = DEFAULT_CONTEXT): ClusterResources {
  const provider = new k8s.Provider("orbstack", { context }, { version: K8S_PLUGIN_VERSION });
  // Namespaces actually created (SDD track 0, Task 6 removed captive-portal's
  // namespace). Hardcoded rather than derived from productSlugs because
  // productSlugs still lists captive-portal (see the InfraNamespaceName
  // comment above); once Task 7+8 prunes it from @www/platform, this goes
  // back to `[...productSlugs, CLOUDFLARE_NAMESPACE]`.
  const namespaceNames = [
    "control-center",
    "dont-text-your-ex",
    "software-factory",
    CLOUDFLARE_NAMESPACE,
  ] as const satisfies readonly InfraNamespaceName[];
  const namespaces = Object.fromEntries(
    namespaceNames.map((name) => [
      name,
      new k8s.core.v1.Namespace(name, { metadata: { name } }, { provider }),
    ]),
  ) as InfraNamespaces;
  return { provider, namespaces };
}
