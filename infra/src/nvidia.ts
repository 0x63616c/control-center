// The `nvidia` RuntimeClass (Task 4, Talos migration): the gaming-PC node has
// a passed-through RTX 3060, and the NVIDIA container toolkit registers a
// `nvidia` OCI runtime handler with containerd (installed at the OS/Talos
// extension level, outside Pulumi's scope, see infra/talos/). A pod requests
// GPU device-plugin scheduling by naming this RuntimeClass AND declaring a
// `nvidia.com/gpu` resource limit (component.ts's ResourceSpec.gpu) , the
// RuntimeClass object alone does not grant GPU access, both are required.
//
// TALOS-ONLY: never installed on "orbstack" (the mini has no GPU passthrough
// and no `nvidia` containerd runtime registered). The install call is gated
// in program.ts behind `substrate === "talos"`; this module itself has no
// substrate awareness, same shape as metallb.ts/local-path.ts.

import * as k8s from "@pulumi/kubernetes";

// Referenced by services.ts (Plex) and homeassistant.ts (HA transcode) as the
// WorkloadSpec.runtimeClassName value. Single source so both call sites (and
// the RuntimeClass object itself) can never drift apart.
export const NVIDIA_RUNTIME_CLASS_NAME = "nvidia";

// The containerd runtime handler name the NVIDIA container toolkit registers.
// Distinct constant from the RuntimeClass's own (Kubernetes-facing) name above
// , they happen to share the literal "nvidia" today, but are conceptually
// different knobs (k8s object name vs. containerd handler name).
const NVIDIA_CONTAINERD_HANDLER = "nvidia";

export interface NvidiaArgs {
  provider: k8s.Provider;
}

export interface NvidiaResources {
  runtimeClass: k8s.node.v1.RuntimeClass;
}

/**
 * @public - the cluster-scoped `nvidia` RuntimeClass. Consumed by program.ts,
 * gated to the "talos" substrate.
 */
export function installNvidiaRuntimeClass(args: NvidiaArgs): NvidiaResources {
  const { provider } = args;
  const runtimeClass = new k8s.node.v1.RuntimeClass(
    NVIDIA_RUNTIME_CLASS_NAME,
    {
      metadata: { name: NVIDIA_RUNTIME_CLASS_NAME },
      handler: NVIDIA_CONTAINERD_HANDLER,
    },
    { provider },
  );
  return { runtimeClass };
}
