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

let cluster: typeof import("../src/cluster.ts");
let component: typeof import("../src/component.ts");

beforeAll(async () => {
  cluster = await import("../src/cluster.ts");
  component = await import("../src/component.ts");
});

function get<T>(r: pulumi.Resource, prop: string): Promise<T> {
  const out = (r as unknown as Record<string, pulumi.Output<T>>)[prop];
  return new Promise((resolve) => {
    out.apply((value) => {
      resolve(value);
      return value;
    });
  });
}

describe("cluster namespaces", () => {
  test("creates product-owned namespaces plus the cloudflare namespace", async () => {
    const res = cluster.makeCluster("test-context");

    expect(Object.keys(res.namespaces).sort()).toEqual([
      "cloudflare",
      "control-center",
      "dont-text-your-ex",
      "software-factory",
    ]);

    const controlCenterMeta = await get<{ name: string }>(
      res.namespaces["control-center"],
      "metadata",
    );
    const cloudflareMeta = await get<{ name: string }>(res.namespaces.cloudflare, "metadata");
    expect(controlCenterMeta.name).toBe("control-center");
    expect(cloudflareMeta.name).toBe("cloudflare");
    const softwareFactoryMeta = await get<{ name: string }>(
      res.namespaces["software-factory"],
      "metadata",
    );
    expect(softwareFactoryMeta.name).toBe("software-factory");
  });
});

describe("Workload logical names", () => {
  test("keeps k8s metadata local while Pulumi uses the product-scoped logical name", async () => {
    const provider = new k8s.Provider("component-test", { context: "x" });
    const workload = new component.Workload({
      logicalName: "control-center-api",
      name: "api",
      namespace: "control-center",
      provider,
      image: "ghcr.io/0x63616c/www-control-center-api:main",
      replicas: 1,
      ports: [{ containerPort: 4201, expose: "cluster" }],
    });

    const deploymentMeta = await get<{ name: string; namespace: string }>(
      workload.deployment,
      "metadata",
    );
    const urn = await get<string>(workload, "urn");

    expect(deploymentMeta).toMatchObject({ name: "api", namespace: "control-center" });
    expect(urn).toContain("control-center-api");
  });
});

describe("HostBackedService", () => {
  test("selector-less ClusterIP + manual EndpointSlice to the host IP, matching port names", async () => {
    const provider = new k8s.Provider("hbs-test", { context: "x" });
    const hbs = new component.HostBackedService({
      name: "ha",
      hostIp: "192.168.0.5",
      port: 8123,
      provider,
      namespace: "control-center",
    });

    const svcSpec = await get<{
      type: string;
      selector?: Record<string, string>;
      ports: { name: string; port: number; targetPort: number; protocol: string }[];
    }>(hbs.service, "spec");
    expect(svcSpec.type).toBe("ClusterIP");
    // No selector: endpoints come from the EndpointSlice, not a pod match.
    expect(svcSpec.selector).toBeUndefined();
    expect(svcSpec.ports).toEqual([
      { name: "http", port: 8123, targetPort: 8123, protocol: "TCP" },
    ]);

    const esMeta = await get<{ name: string; labels: Record<string, string> }>(
      hbs.endpointSlice,
      "metadata",
    );
    expect(esMeta.name).toBe("ha-manual");
    // The Service association label kube-proxy keys on.
    expect(esMeta.labels["kubernetes.io/service-name"]).toBe("ha");

    const endpoints = await get<{ addresses: string[]; conditions: { ready: boolean } }[]>(
      hbs.endpointSlice,
      "endpoints",
    );
    expect(endpoints).toEqual([{ addresses: ["192.168.0.5"], conditions: { ready: true } }]);

    // EndpointSlice port name MUST match the Service port name or the endpoint
    // is ignored.
    const esPorts = await get<{ name: string; port: number; protocol: string }[]>(
      hbs.endpointSlice,
      "ports",
    );
    expect(esPorts).toEqual([{ name: "http", port: 8123, protocol: "TCP" }]);
  });
});
