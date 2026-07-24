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

let metallb: typeof import("../src/metallb.ts");
beforeAll(async () => {
  metallb = await import("../src/metallb.ts");
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

describe("installMetallb (Task 4, talos-only)", () => {
  test("the IPAddressPool covers exactly the locked M3 range (192.168.0.3-192.168.0.4)", async () => {
    const res = metallb.installMetallb({ provider: provider(), version: "v0.14.9" });
    const spec = await get<{ addresses: string[] }>(res.addressPool, "spec");
    expect(spec.addresses).toEqual([metallb.METALLB_ADDRESS_POOL_RANGE]);
    expect(metallb.METALLB_ADDRESS_POOL_RANGE).toBe("192.168.0.3-192.168.0.4");
  });

  test("the L2Advertisement targets the same pool the IPAddressPool declares", async () => {
    const res = metallb.installMetallb({ provider: provider(), version: "v0.14.9" });
    const poolMeta = await get<{ name: string }>(res.addressPool, "metadata");
    const l2Spec = await get<{ ipAddressPools: string[] }>(res.l2Advertisement, "spec");
    expect(l2Spec.ipAddressPools).toEqual([poolMeta.name]);
  });
});
