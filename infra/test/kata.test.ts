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

let kata: typeof import("../src/kata.ts");
beforeAll(async () => {
  kata = await import("../src/kata.ts");
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

describe("installKataRuntimeClass (program handoff step 1, #432, talos-only)", () => {
  test("creates a RuntimeClass named 'kata' with the kata containerd handler", async () => {
    const res = kata.installKataRuntimeClass({ provider: provider() });
    const meta = await get<{ name: string }>(res.runtimeClass, "metadata");
    const handler = await get<string>(res.runtimeClass, "handler");
    expect(meta.name).toBe("kata");
    expect(handler).toBe("kata");
  });

  test("overhead.podFixed matches the extension's documented cloud-hypervisor defaults", async () => {
    const res = kata.installKataRuntimeClass({ provider: provider() });
    const overhead = await get<{ podFixed: { memory: string; cpu: string } }>(
      res.runtimeClass,
      "overhead",
    );
    expect(overhead.podFixed).toEqual({ memory: "130Mi", cpu: "250m" });
  });

  test("KATA_RUNTIME_CLASS_NAME is the single source future sandbox-scheduling consumers use", () => {
    expect(kata.KATA_RUNTIME_CLASS_NAME).toBe("kata");
  });
});
