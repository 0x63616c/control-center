/**
 * OpenEBS LocalPV-LVM (ADR-0009): the storage layer that makes PVC capacity
 * REAL. Each PVC is an LVM logical volume in VG `storage` (raw partition
 * carved next to the capped EPHEMERAL) — writes fail at the declared size,
 * expansion is online, kubelet_volume_stats exist. Operator installed from
 * the pinned upstream manifest (ADR-0007 pattern: ConfigFile, never Helm).
 */
import * as k8s from "@pulumi/kubernetes";

const LVM_LOCALPV_VERSION = "v1.9.1"; // pin; bump deliberately
const OPERATOR_URL = `https://raw.githubusercontent.com/openebs/lvm-localpv/${LVM_LOCALPV_VERSION}/deploy/lvm-operator.yaml`;

/** The VG name the cutover's vg-bootstrap pod creates; also in the SC params. */
export const VOLUME_GROUP = "storage";
export const STORAGE_CLASS_NAME = "local-lvm";

export interface LvmLocalPvArgs {
  provider: k8s.Provider;
}

export function installLvmLocalPv(args: LvmLocalPvArgs) {
  const opts = { provider: args.provider };

  const operator = new k8s.yaml.v2.ConfigFile("lvm-localpv-operator", { file: OPERATOR_URL }, opts);

  const storageClass = new k8s.storage.v1.StorageClass(
    STORAGE_CLASS_NAME,
    {
      metadata: {
        name: STORAGE_CLASS_NAME,
        // The ONLY StorageClass (local-path is deleted, ADR-0009): default so
        // every PVC that names nothing lands on enforced storage.
        annotations: { "storageclass.kubernetes.io/is-default-class": "true" },
      },
      provisioner: "local.csi.openebs.io",
      // Thick on purpose: a 10Gi PVC RESERVES 10Gi. Thin would reintroduce
      // "capacity is a suggestion" through the back door.
      parameters: { storage: "lvm", volgroup: VOLUME_GROUP, fsType: "xfs" },
      allowVolumeExpansion: true,
      reclaimPolicy: "Delete",
      volumeBindingMode: "WaitForFirstConsumer",
    },
    { ...opts, dependsOn: [operator] },
  );

  return { operator, storageClass };
}
