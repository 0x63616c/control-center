// The `kata` RuntimeClass (program handoff step 1, software-factory migration:
// /tmp/handoffs/2026-07-29-software-factory-migration-program.md, issue #432).
// Kata Containers runs pods inside a lightweight VM instead of a shared-kernel
// `runc` container, so a later step can schedule untrusted software-factory
// agent work into VM-isolated pods without trusting containerd's namespace
// isolation alone.
//
// The `kata-containers` Talos system extension (infra/talos/talconfig.yaml)
// self-registers two containerd runtime handlers, `kata` (cloud-hypervisor
// VMM) and `kata-qemu` (QEMU VMM) — this module only creates the k8s-facing
// RuntimeClass object, same split as nvidia.ts: the handler itself comes from
// the OS/Talos extension, not from anything Pulumi installs. Unlike nvidia.ts
// there is no device-plugin DaemonSet counterpart — Kata needs no scheduler
// resource advertisement, a pod opts in purely by naming this RuntimeClass.
//
// TALOS-ONLY: never installed on "orbstack" (no `kata-containers` extension,
// no `kata` containerd runtime registered there). The install call is gated
// in program.ts behind `substrate === "talos"`, same as nvidia.ts; this module
// itself has no substrate awareness.

import * as k8s from "@pulumi/kubernetes";

// Referenced by whatever later step schedules software-factory sandbox pods
// (not yet built — this step is deliberately upstream of and disconnected
// from the software factory itself). Single source so the RuntimeClass object
// and any future consumer can never drift apart.
export const KATA_RUNTIME_CLASS_NAME = "kata";

// The containerd runtime handler name the kata-containers Talos extension
// registers for the cloud-hypervisor VMM. Distinct constant from the
// RuntimeClass's own (Kubernetes-facing) name above — they happen to share
// the literal "kata" today, but are conceptually different knobs (k8s object
// name vs. containerd handler name), same distinction nvidia.ts draws. If
// cloud-hypervisor turns out not to work on this board (unverified per the
// spec's Risks section), the extension registers `kata-qemu` identically —
// swapping this one constant is the whole change.
const KATA_CONTAINERD_HANDLER = "kata";

export interface KataArgs {
  provider: k8s.Provider;
}

export interface KataResources {
  runtimeClass: k8s.node.v1.RuntimeClass;
}

/**
 * @public - the cluster-scoped `kata` RuntimeClass. Consumed by program.ts,
 * gated to the "talos" substrate. `overhead.podFixed` values are quoted from
 * the kata-containers Talos extension's own documented `RuntimeClass`
 * example (cloud-hypervisor handler defaults), not independently measured on
 * this hardware — re-confirm against the extension's current docs before
 * trusting them verbatim.
 */
export function installKataRuntimeClass(args: KataArgs): KataResources {
  const { provider } = args;
  const runtimeClass = new k8s.node.v1.RuntimeClass(
    KATA_RUNTIME_CLASS_NAME,
    {
      metadata: { name: KATA_RUNTIME_CLASS_NAME },
      handler: KATA_CONTAINERD_HANDLER,
      overhead: {
        podFixed: { memory: "130Mi", cpu: "250m" },
      },
    },
    { provider },
  );
  return { runtimeClass };
}
