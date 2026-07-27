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

let mod: typeof import("../src/lvm-localpv.ts");
beforeAll(async () => {
  mod = await import("../src/lvm-localpv.ts");
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

describe("installLvmLocalPv", () => {
  test("local-lvm StorageClass: enforced, expandable, thick, xfs, default", async () => {
    const { storageClass } = mod.installLvmLocalPv({ provider: provider() });
    expect(await get(storageClass, "provisioner")).toBe("local.csi.openebs.io");
    expect(await get(storageClass, "allowVolumeExpansion")).toBe(true);
    expect(await get(storageClass, "reclaimPolicy")).toBe("Delete");
    expect(await get(storageClass, "volumeBindingMode")).toBe("WaitForFirstConsumer");
    const params = await get<Record<string, string>>(storageClass, "parameters");
    expect(params).toMatchObject({ storage: "lvm", volgroup: "storage", fsType: "xfs" });
    expect(params.thinProvision ?? "no").toBe("no");
    const meta = await get<{ annotations?: Record<string, string> }>(storageClass, "metadata");
    expect(meta.annotations?.["storageclass.kubernetes.io/is-default-class"]).toBe("true");
  });

  test("exports the literal names Tasks 4/5/7 depend on", () => {
    expect(mod.STORAGE_CLASS_NAME).toBe("local-lvm");
    expect(mod.VOLUME_GROUP).toBe("storage");
  });
});
