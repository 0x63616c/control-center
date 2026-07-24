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

let localPath: typeof import("../src/local-path.ts");
beforeAll(async () => {
  localPath = await import("../src/local-path.ts");
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

describe("installLocalPath (Task 4, talos-only)", () => {
  test("installs the pinned rancher local-path-provisioner manifest", async () => {
    const res = localPath.installLocalPath({ provider: provider(), version: "v0.0.31" });
    const urn = await get<string>(res.provisioner, "urn");
    expect(urn).toContain("local-path-provisioner");
  });

  test("patches the 'local-path' StorageClass to be the cluster default", async () => {
    const res = localPath.installLocalPath({ provider: provider(), version: "v0.0.31" });
    const meta = await get<{ name: string; annotations: Record<string, string> }>(
      res.defaultStorageClassPatch,
      "metadata",
    );
    expect(meta.name).toBe("local-path");
    expect(meta.annotations["storageclass.kubernetes.io/is-default-class"]).toBe("true");
  });
});
