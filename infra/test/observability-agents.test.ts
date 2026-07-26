import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, test } from "vitest";

pulumi.runtime.setMocks({
  newResource(args: pulumi.runtime.MockResourceArgs) {
    return { id: `${args.name}-id`, state: args.inputs };
  },
  call() {
    return {};
  },
});

let nodeExporter: typeof import("../src/observability/node-exporter.ts");
let kubeStateMetrics: typeof import("../src/observability/kube-state-metrics.ts");
beforeAll(async () => {
  nodeExporter = await import("../src/observability/node-exporter.ts");
  kubeStateMetrics = await import("../src/observability/kube-state-metrics.ts");
});

function get<T>(r: pulumi.Resource, prop: string): Promise<T> {
  const out = (r as unknown as Record<string, pulumi.Output<T>>)[prop];
  return new Promise((resolve) => {
    out.apply((v) => {
      resolve(v);
      return v;
    });
  });
}

const provider = () => new k8s.Provider("test", { context: "x" });
const namespace = () =>
  new k8s.core.v1.Namespace("observability-test", { metadata: { name: "observability" } });

interface VolumeMount {
  name: string;
  mountPath: string;
  readOnly?: boolean;
  mountPropagation?: string;
}
interface Container {
  name: string;
  image: string;
  args?: string[];
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  volumeMounts?: VolumeMount[];
}
interface PodSpec {
  hostNetwork?: boolean;
  hostPID?: boolean;
  dnsPolicy?: string;
  priorityClassName?: string;
  tolerations?: { key: string; operator: string; effect: string }[];
  containers: Container[];
  volumes?: { name: string; hostPath?: { path: string } }[];
}
interface WorkloadSpec {
  template: { spec: PodSpec };
}

const install = () => ({ provider: provider(), namespace: namespace() });

describe("installNodeExporter", () => {
  test("the DaemonSet reads the HOST's namespaces, not the container's", async () => {
    const { daemonSet } = nodeExporter.installNodeExporter(install());
    const spec = await get<WorkloadSpec>(daemonSet, "spec");
    const pod = spec.template.spec;

    expect(pod.hostNetwork).toBe(true);
    expect(pod.hostPID).toBe(true);
    // Mandatory alongside hostNetwork or the pod cannot resolve cluster DNS.
    expect(pod.dnsPolicy).toBe("ClusterFirstWithHostNet");
    expect(pod.priorityClassName).toBe("system-node-critical");
    expect(pod.tolerations).toContainEqual({
      key: "node-role.kubernetes.io/control-plane",
      operator: "Exists",
      effect: "NoSchedule",
    });
  });

  test("mounts /proc, /sys and / read-only, with HostToContainer propagation on the rootfs", async () => {
    const { daemonSet } = nodeExporter.installNodeExporter(install());
    const spec = await get<WorkloadSpec>(daemonSet, "spec");
    const pod = spec.template.spec;

    const hostPaths = (pod.volumes ?? []).map((v) => v.hostPath?.path);
    expect(hostPaths).toEqual(expect.arrayContaining(["/proc", "/sys", "/"]));

    const mounts = pod.containers[0].volumeMounts ?? [];
    const byPath = Object.fromEntries(mounts.map((m) => [m.mountPath, m]));
    expect(byPath["/host/proc"]).toMatchObject({ readOnly: true });
    expect(byPath["/host/sys"]).toMatchObject({ readOnly: true });
    // Without HostToContainer, mounts made after the pod starts never appear.
    expect(byPath["/host/root"]).toMatchObject({
      readOnly: true,
      mountPropagation: "HostToContainer",
    });

    // The exporter must be pointed at the host mounts, not its own /proc.
    expect(pod.containers[0].args).toEqual(
      expect.arrayContaining([
        "--path.procfs=/host/proc",
        "--path.sysfs=/host/sys",
        "--path.rootfs=/host/root",
        "--web.listen-address=:9100",
      ]),
    );
  });

  test("the Service Prometheus discovers is named node-exporter with a `metrics` port", async () => {
    const { service } = nodeExporter.installNodeExporter(install());
    const meta = await get<{ name: string; namespace: string }>(service, "metadata");
    const spec = await get<{
      type: string;
      selector: Record<string, string>;
      ports: { name: string; port: number }[];
    }>(service, "spec");

    // Load-bearing: the vendored mixin rules select on job="node-exporter".
    expect(meta).toMatchObject({ name: "node-exporter", namespace: "observability" });
    expect(spec.type).toBe("ClusterIP");
    expect(spec.selector).toEqual({ "app.kubernetes.io/name": "node-exporter" });
    expect(spec.ports).toContainEqual(expect.objectContaining({ name: "metrics", port: 9100 }));
  });

  test("sets cpu requests but never a cpu limit", async () => {
    const { daemonSet } = nodeExporter.installNodeExporter(install());
    const spec = await get<WorkloadSpec>(daemonSet, "spec");
    for (const c of spec.template.spec.containers) {
      expect(c.resources?.requests?.cpu).toBeDefined();
      expect(c.resources?.limits?.cpu).toBeUndefined();
    }
  });
});

describe("installKubeStateMetrics", () => {
  test("sets cpu requests but never a cpu limit", async () => {
    const { deployment } = kubeStateMetrics.installKubeStateMetrics(install());
    const spec = await get<WorkloadSpec>(deployment, "spec");
    for (const c of spec.template.spec.containers) {
      expect(c.resources?.requests?.cpu).toBeDefined();
      expect(c.resources?.limits?.cpu).toBeUndefined();
    }
  });

  test("runs unprivileged as nobody with a read-only root filesystem", async () => {
    const { deployment } = kubeStateMetrics.installKubeStateMetrics(install());
    const spec = await get<{
      replicas: number;
      template: {
        spec: {
          serviceAccountName: string;
          containers: {
            securityContext: {
              runAsUser: number;
              runAsNonRoot: boolean;
              allowPrivilegeEscalation: boolean;
              readOnlyRootFilesystem: boolean;
            };
          }[];
        };
      };
    }>(deployment, "spec");

    expect(spec.replicas).toBe(1);
    expect(spec.template.spec.serviceAccountName).toBe("kube-state-metrics");
    expect(spec.template.spec.containers[0].securityContext).toMatchObject({
      runAsUser: 65534,
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
    });
  });

  test("the ClusterRole keeps the full upstream resource list (a missing verb silently drops a metric family)", async () => {
    const { clusterRole } = kubeStateMetrics.installKubeStateMetrics(install());
    const rules = await get<{ apiGroups: string[]; resources: string[]; verbs: string[] }[]>(
      clusterRole,
      "rules",
    );
    const listWatchable = new Set(
      rules.filter((r) => r.verbs.includes("list")).flatMap((r) => r.resources),
    );
    for (const resource of [
      "configmaps",
      "secrets",
      "nodes",
      "pods",
      "services",
      "namespaces",
      "endpoints",
      "resourcequotas",
      "limitranges",
      "persistentvolumeclaims",
      "persistentvolumes",
      "deployments",
      "statefulsets",
      "daemonsets",
      "replicasets",
      "jobs",
      "cronjobs",
      "ingresses",
      "networkpolicies",
      "storageclasses",
      "volumeattachments",
      "certificatesigningrequests",
      "poddisruptionbudgets",
      "horizontalpodautoscalers",
      "leases",
    ]) {
      expect(listWatchable).toContain(resource);
    }
  });

  test("the Service Prometheus discovers is named kube-state-metrics on an http-metrics port", async () => {
    const { service } = kubeStateMetrics.installKubeStateMetrics(install());
    const meta = await get<{ name: string; namespace: string }>(service, "metadata");
    const spec = await get<{ type: string; ports: { name: string; port: number }[] }>(
      service,
      "spec",
    );
    expect(meta).toMatchObject({ name: "kube-state-metrics", namespace: "observability" });
    expect(spec.type).toBe("ClusterIP");
    expect(spec.ports).toContainEqual(
      expect.objectContaining({ name: "http-metrics", port: 8080 }),
    );
  });
});
