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

// The upstream NVIDIA k8s device plugin. Pinned tag (never :latest): the plugin
// is what makes the node advertise `nvidia.com/gpu` capacity to the scheduler,
// so a silent roll on node restart is unwanted. Public NGC image, no pull secret.
const NVIDIA_DEVICE_PLUGIN_IMAGE = "nvcr.io/nvidia/k8s-device-plugin:v0.17.1";

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

/**
 * @public - the NVIDIA k8s device plugin DaemonSet. WITHOUT it the node never
 * advertises `nvidia.com/gpu`, so a pod that names the RuntimeClass + a
 * `nvidia.com/gpu` limit (Plex) is unschedulable forever. The plugin container
 * itself runs under the `nvidia` RuntimeClass so it can see the GPU (the
 * container toolkit only exposes devices to nvidia-runtime containers), then
 * registers the GPU with the kubelet device-plugin socket via the hostPath
 * mount. Requires the nvidia kernel modules to be loaded (infra/talos
 * machine.kernel.modules). Consumed by program.ts, gated to "talos".
 */
export function installNvidiaDevicePlugin(args: NvidiaArgs): k8s.apps.v1.DaemonSet {
  const { provider } = args;
  const labels = { name: "nvidia-device-plugin-ds" };
  return new k8s.apps.v1.DaemonSet(
    "nvidia-device-plugin",
    {
      metadata: { name: "nvidia-device-plugin-daemonset", namespace: "kube-system" },
      spec: {
        selector: { matchLabels: labels },
        updateStrategy: { type: "RollingUpdate" },
        template: {
          metadata: { labels },
          spec: {
            runtimeClassName: NVIDIA_RUNTIME_CLASS_NAME,
            priorityClassName: "system-node-critical",
            // Schedule on the (tainted or not) control-plane node and on any
            // future GPU-tainted node; this single node is both.
            tolerations: [
              { key: "nvidia.com/gpu", operator: "Exists", effect: "NoSchedule" },
              {
                key: "node-role.kubernetes.io/control-plane",
                operator: "Exists",
                effect: "NoSchedule",
              },
            ],
            containers: [
              {
                name: "nvidia-device-plugin-ctr",
                image: NVIDIA_DEVICE_PLUGIN_IMAGE,
                // Don't crash-loop the plugin on a node that (transiently) has no
                // GPU/driver; it just advertises 0 until the driver is ready.
                env: [{ name: "FAIL_ON_INIT_ERROR", value: "false" }],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ["ALL"] },
                },
                volumeMounts: [
                  { name: "device-plugin", mountPath: "/var/lib/kubelet/device-plugins" },
                ],
              },
            ],
            volumes: [
              {
                name: "device-plugin",
                hostPath: { path: "/var/lib/kubelet/device-plugins" },
              },
            ],
          },
        },
      },
    },
    { provider },
  );
}
