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

let softwareFactory: typeof import("../src/software-factory.ts");
let temporal: typeof import("../src/temporal.ts");
beforeAll(async () => {
  softwareFactory = await import("../src/software-factory.ts");
  temporal = await import("../src/temporal.ts");
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

const install = () =>
  softwareFactory.installSoftwareFactory({
    provider: new k8s.Provider("test", { context: "x" }),
  });

describe("installSoftwareFactory (ADR-0011, issue #325, talos-only)", () => {
  test("creates its own 'software-factory' namespace, outside InfraNamespaceName", async () => {
    const meta = await get<{ name: string }>(install().namespace, "metadata");
    expect(meta.name).toBe("software-factory");
    expect(softwareFactory.SOFTWARE_FACTORY_NAMESPACE).toBe("software-factory");
  });

  test("the k8s namespace and the Temporal namespace share one name", () => {
    // Two different kinds of namespace, deliberately named the same: one
    // vocabulary for "the software factory's isolation boundary". A drift here
    // would be silently confusing in logs, Grafana labels and workflow IDs.
    expect(softwareFactory.SOFTWARE_FACTORY_NAMESPACE).toBe(
      temporal.SOFTWARE_FACTORY_TEMPORAL_NAMESPACE,
    );
  });

  test("inherits the cluster-default baseline Pod Security, unlike home-assistant", async () => {
    // The sandbox that runs agent-authored code is a per-workload concern (it
    // gets its own hardening when it lands), NOT a reason to relax admission
    // for the whole namespace. Anything that needs `privileged` here should
    // have to argue for it explicitly, as homeassistant.ts does.
    const meta = await get<{ labels?: Record<string, string> }>(install().namespace, "metadata");
    expect(meta.labels?.["pod-security.kubernetes.io/enforce"]).toBeUndefined();
  });
});
