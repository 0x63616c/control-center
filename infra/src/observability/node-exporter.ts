/**
 * node-exporter (#33, ADR #207) — per-node hardware/OS metrics.
 *
 * Hand-rolled DaemonSet, same idiom as infra/src/nvidia.ts: no Helm chart, no
 * prometheus-operator. Prometheus finds it through the `node-exporter` Service's
 * endpoints, and the vendored kubernetes-mixin rules select on a scrape job
 * literally named `node-exporter`, so neither the Service name nor the pod
 * labels below are free to change.
 */

import * as k8s from "@pulumi/kubernetes";
import { NODE_EXPORTER_IMAGE, NODE_EXPORTER_PORT, OBSERVABILITY_NAMESPACE } from "./constants.ts";

const NAME = "node-exporter";

/** Selector shared by the DaemonSet, its pod template and the Service. */
const LABELS = { "app.kubernetes.io/name": NAME };

/**
 * Talos's root filesystem is read-only with a non-standard layout (`/system`,
 * an ephemeral `/var`), so the node presents a pile of squashfs/overlay mounts
 * that are not "disks" in any sense a dashboard cares about. Without these
 * exclusions the "Node / Filesystem" panels are dominated by 100%-full
 * read-only squashfs rows. Standard upstream regexes (node_exporter defaults as
 * shipped by the prometheus-community chart), not hand-tuned for Talos.
 */
const FILESYSTEM_MOUNT_POINTS_EXCLUDE =
  "^/(dev|proc|sys|run/credentials/.+|var/lib/docker/.+|var/lib/kubelet/pods/.+)($|/)";
const FILESYSTEM_FS_TYPES_EXCLUDE =
  "^(autofs|binfmt_misc|bpf|cgroup2?|configfs|debugfs|devpts|devtmpfs|fusectl|hugetlbfs|iso9660|mqueue|nsfs|overlay|proc|procfs|pstore|rpc_pipefs|securityfs|selinuxfs|squashfs|sysfs|tracefs)$";

export type NodeExporterArgs = {
  provider: k8s.Provider;
  namespace: k8s.core.v1.Namespace;
};

export type NodeExporterResources = {
  daemonSet: k8s.apps.v1.DaemonSet;
  /** Prometheus's `role: endpoints` SD target for the `node-exporter` job. */
  service: k8s.core.v1.Service;
};

/**
 * @public - the node-exporter DaemonSet + its headful ClusterIP Service.
 * Consumed by infra/src/observability/index.ts.
 *
 * hostNetwork/hostPID/hostPath are what make the metrics real: the exporter
 * reads the HOST's /proc and /sys, not the container's, and hostPID is needed
 * for the process/systemd-adjacent collectors to see host PIDs. This is why the
 * observability namespace is labelled Pod Security `privileged` — Talos
 * enforces `baseline` everywhere else, which forbids all three.
 */
export function installNodeExporter(args: NodeExporterArgs): NodeExporterResources {
  const { provider, namespace } = args;
  const opts = { provider, dependsOn: [namespace] };

  const daemonSet = new k8s.apps.v1.DaemonSet(
    NAME,
    {
      metadata: { name: NAME, namespace: OBSERVABILITY_NAMESPACE, labels: LABELS },
      spec: {
        selector: { matchLabels: LABELS },
        updateStrategy: { type: "RollingUpdate" },
        template: {
          metadata: { labels: LABELS },
          spec: {
            hostNetwork: true,
            hostPID: true,
            // Required whenever hostNetwork is set, otherwise the pod resolves
            // against the host's resolv.conf and cannot reach cluster DNS.
            dnsPolicy: "ClusterFirstWithHostNet",
            priorityClassName: "system-node-critical",
            // Our single node carries NO taints today, so this toleration is
            // future-proofing rather than a requirement: it keeps node-exporter
            // covering every node if a properly tainted control-plane node is
            // ever added.
            tolerations: [
              {
                key: "node-role.kubernetes.io/control-plane",
                operator: "Exists",
                effect: "NoSchedule",
              },
            ],
            containers: [
              {
                name: NAME,
                image: NODE_EXPORTER_IMAGE,
                args: [
                  "--path.procfs=/host/proc",
                  "--path.sysfs=/host/sys",
                  "--path.rootfs=/host/root",
                  `--web.listen-address=:${NODE_EXPORTER_PORT}`,
                  // Nothing writes textfile collector files on Talos (there is
                  // no writable node directory to drop them in), so the
                  // collector only ever produces errors.
                  "--no-collector.textfile",
                  `--collector.filesystem.mount-points-exclude=${FILESYSTEM_MOUNT_POINTS_EXCLUDE}`,
                  `--collector.filesystem.fs-types-exclude=${FILESYSTEM_FS_TYPES_EXCLUDE}`,
                ],
                ports: [{ name: "metrics", containerPort: NODE_EXPORTER_PORT, protocol: "TCP" }],
                // Requests only — never a cpu limit (repo-wide rule, enforced by
                // infra/test/render.test.ts): throttling the exporter makes it
                // miss scrapes and turns into fake "node down" alerts.
                resources: {
                  requests: { cpu: "20m", memory: "48Mi" },
                  limits: { memory: "192Mi" },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  runAsNonRoot: true,
                  runAsUser: 65534,
                  capabilities: { drop: ["ALL"] },
                },
                livenessProbe: {
                  httpGet: { path: "/", port: NODE_EXPORTER_PORT },
                  initialDelaySeconds: 5,
                },
                readinessProbe: {
                  httpGet: { path: "/", port: NODE_EXPORTER_PORT },
                  initialDelaySeconds: 5,
                },
                volumeMounts: [
                  { name: "proc", mountPath: "/host/proc", readOnly: true },
                  { name: "sys", mountPath: "/host/sys", readOnly: true },
                  {
                    name: "root",
                    mountPath: "/host/root",
                    readOnly: true,
                    // Without HostToContainer the container sees only the mounts
                    // that existed when it started, so every filesystem mounted
                    // afterwards silently vanishes from the metrics.
                    mountPropagation: "HostToContainer",
                  },
                ],
              },
            ],
            volumes: [
              { name: "proc", hostPath: { path: "/proc" } },
              { name: "sys", hostPath: { path: "/sys" } },
              { name: "root", hostPath: { path: "/" } },
            ],
          },
        },
      },
    },
    opts,
  );

  // ClusterIP even though the pods are hostNetwork: Prometheus discovers them
  // via this Service's endpoints (`role: endpoints`), it never dials the
  // ClusterIP itself.
  const service = new k8s.core.v1.Service(
    NAME,
    {
      metadata: { name: NAME, namespace: OBSERVABILITY_NAMESPACE, labels: LABELS },
      spec: {
        type: "ClusterIP",
        selector: LABELS,
        ports: [
          {
            name: "metrics",
            port: NODE_EXPORTER_PORT,
            targetPort: NODE_EXPORTER_PORT,
            protocol: "TCP",
          },
        ],
      },
    },
    opts,
  );

  return { daemonSet, service };
}
