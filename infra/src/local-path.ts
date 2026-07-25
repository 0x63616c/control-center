// local-path-provisioner (Task 4, Talos migration): OrbStack ships its own
// built-in `local-path` StorageClass/provisioner for free (that's what every
// `storageClassName: "local-path"` PVC in services.ts/cnpg.ts already binds
// against on the mini). Talos ships NO storage provisioner at all , without
// this, every local-path PVC (CNPG, plex-config, ha-config, maps) sits Pending
// forever. Rancher's local-path-provisioner is the direct drop-in: same
// StorageClass name ("local-path"), same behavior (a hostPath dir per PVC on
// the node's local disk), so zero other file in this repo needs to change to
// target it.
//
// Namespace `local-path-storage` is created BY the pinned upstream manifest
// itself (not threaded through cluster.ts's closed InfraNamespaceName map, see
// its comment) , L1: every new Task 4 component owns its own namespace.
//
// TALOS-ONLY: never installed on "orbstack" (the mini already has its own
// local-path provisioner; installing a second one in the same cluster would
// fight over the "local-path" StorageClass name). Gated in program.ts behind
// `substrate === "talos"`.

import * as k8s from "@pulumi/kubernetes";

const STORAGE_CLASS_NAME = "local-path";

export interface LocalPathArgs {
  provider: k8s.Provider;
  // Pinned manifest tag (a git ref in the upstream repo, e.g. "v0.0.31").
  version: string;
}

export interface LocalPathResources {
  provisioner: k8s.yaml.ConfigFile;
  // Patches the manifest's StorageClass to be the cluster default, so a PVC
  // that omits storageClassName still binds (CNPG omits it too in some
  // configurations); every explicit `storageClassName: "local-path"` PVC in
  // this repo works either way.
  defaultStorageClassPatch: k8s.storage.v1.StorageClassPatch;
  // PSA relabel of the provisioner namespace to `privileged` so its hostPath
  // helper-pods are admitted (Talos defaults the ns to `baseline`).
  namespacePsaPatch: k8s.core.v1.NamespacePatch;
}

/**
 * @public - installs rancher/local-path-provisioner and marks its
 * StorageClass default. Consumed by program.ts, gated to the "talos" substrate.
 */
export function installLocalPath(args: LocalPathArgs): LocalPathResources {
  const { provider, version } = args;
  const opts = { provider };

  const provisioner = new k8s.yaml.ConfigFile(
    "local-path-provisioner",
    {
      file: `https://raw.githubusercontent.com/rancher/local-path-provisioner/${version}/deploy/local-path-storage.yaml`,
    },
    opts,
  );

  // The provisioner works by spawning a short-lived `helper-pod` that mounts a
  // hostPath dir on the node to create/delete each PVC's backing directory. On
  // Talos the `local-path-storage` namespace defaults to PodSecurity `baseline`,
  // which FORBIDS hostPath volumes , so every helper-pod is rejected
  // ("violates PodSecurity baseline: hostPath volumes") and every local-path PVC
  // (CNPG primaries, plex-config, ha-config, maps) sits Pending forever. Label
  // the namespace `privileged` so the helper-pod's hostPath is allowed. The
  // upstream manifest owns the Namespace object, so patch it (SSA) rather than
  // redeclaring it.
  const namespacePsaPatch = new k8s.core.v1.NamespacePatch(
    "local-path-storage-psa",
    {
      metadata: {
        name: "local-path-storage",
        labels: {
          "pod-security.kubernetes.io/enforce": "privileged",
          "pod-security.kubernetes.io/warn": "privileged",
          "pod-security.kubernetes.io/audit": "privileged",
        },
      },
    },
    { ...opts, dependsOn: [provisioner] },
  );

  // Server-side-apply patch (not a full StorageClass resource): the manifest
  // above already owns the "local-path" StorageClass object, so this only
  // adds the default-class annotation rather than fighting over ownership of
  // the whole object.
  const defaultStorageClassPatch = new k8s.storage.v1.StorageClassPatch(
    "local-path-default",
    {
      metadata: {
        name: STORAGE_CLASS_NAME,
        annotations: { "storageclass.kubernetes.io/is-default-class": "true" },
      },
    },
    { ...opts, dependsOn: [provisioner] },
  );

  return { provisioner, defaultStorageClassPatch, namespacePsaPatch };
}
