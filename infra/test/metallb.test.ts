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

// The single-node announcement fix (#29): without --ignore-exclude-lb the
// speaker silently refuses to announce from this control-plane node, and BOTH
// LAN LoadBalancers (.3 guest portal, .4 plex) go dark with no error logged.
describe("withIgnoreExcludeLb", () => {
  const speakerDs = () => ({
    kind: "DaemonSet",
    metadata: { name: "speaker" },
    spec: {
      template: { spec: { containers: [{ name: "speaker", args: ["--port=7472"] }] } },
    },
  });

  test("appends the flag to the speaker container, preserving upstream args", () => {
    const ds = speakerDs();
    metallb.withIgnoreExcludeLb(ds);
    expect(ds.spec.template.spec.containers[0]?.args).toEqual([
      "--port=7472",
      metallb.IGNORE_EXCLUDE_LB_FLAG,
    ]);
  });

  test("is idempotent, so a re-apply does not accumulate duplicate flags", () => {
    const ds = speakerDs();
    metallb.withIgnoreExcludeLb(ds);
    metallb.withIgnoreExcludeLb(ds);
    expect(
      ds.spec.template.spec.containers[0]?.args?.filter(
        (a) => a === metallb.IGNORE_EXCLUDE_LB_FLAG,
      ),
    ).toHaveLength(1);
  });

  test("leaves every other object in the upstream manifest untouched", () => {
    const controller = {
      kind: "Deployment",
      metadata: { name: "controller" },
      spec: { template: { spec: { containers: [{ name: "controller", args: ["--port=7472"] }] } } },
    };
    metallb.withIgnoreExcludeLb(controller);
    expect(controller.spec.template.spec.containers[0]?.args).toEqual(["--port=7472"]);
  });
});
