// The `software-factory` k8s namespace (ADR-0011): where the Go worker that
// works GitHub tickets, and the sandbox it runs agent-authored code in, will
// live. Right now it holds NOTHING — the namespace exists ahead of its
// workloads deliberately, because #325 surfaced that ADR-0011 assumed both this
// namespace and the Temporal one existed without ever saying who creates them.
// This file is the answer for the k8s one; temporal.ts's TEMPORAL_NAMESPACES is
// the answer for the Temporal one.
//
// L1: NOT in cluster.ts's closed InfraNamespaceName map — this module creates
// its own namespace, the same way homeassistant.ts and temporal.ts do. That map
// is derived from `ProductSlug`, and software-factory is not a @www/platform
// product: it ships no web/api image, has no CNPG database, and is not part of
// the control-center deploy. Widening ProductSlug to reach it would force an
// entry in every `Record<InfraNamespaceName, …>` consumer (eso, cnpg, crons,
// ghcr-pull-secrets) for a namespace that needs none of them.
//
// Why its own namespace at all, rather than running in `control-center`: the
// sandbox executes code an agent wrote. That boundary wants its own RBAC,
// quotas and network policy, and it wants them somewhere a mistake cannot reach
// the house's own workloads. Same reasoning as its separate Temporal namespace.
//
// TALOS-ONLY: a no-op unless installSoftwareFactory() is called, which
// program.ts only does behind `substrate === "talos"`.

import * as k8s from "@pulumi/kubernetes";

/**
 * The k8s namespace the software factory's workloads live in. Deliberately the
 * same string as {@link import("./temporal.ts").SOFTWARE_FACTORY_TEMPORAL_NAMESPACE}:
 * one name for the isolation boundary, whichever kind of namespace is meant.
 */
export const SOFTWARE_FACTORY_NAMESPACE = "software-factory";

export interface SoftwareFactoryArgs {
  provider: k8s.Provider;
}

export interface SoftwareFactoryResources {
  namespace: k8s.core.v1.Namespace;
}

/**
 * @public - installs the `software-factory` namespace. Workloads (the Go worker
 * and its sandbox) land here in a later change, once their images exist.
 */
export function installSoftwareFactory(args: SoftwareFactoryArgs): SoftwareFactoryResources {
  const { provider } = args;
  // No Pod Security label: the cluster-default `baseline` applies. The sandbox
  // needs hardening, not privilege, so nothing here should be relaxing
  // admission for the whole namespace — anything that needs more has to argue
  // for it at the point it lands, the way homeassistant.ts does.
  const namespace = new k8s.core.v1.Namespace(
    SOFTWARE_FACTORY_NAMESPACE,
    { metadata: { name: SOFTWARE_FACTORY_NAMESPACE } },
    { provider },
  );
  return { namespace };
}
