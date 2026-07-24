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

let nvidia: typeof import("../src/nvidia.ts");
beforeAll(async () => {
  nvidia = await import("../src/nvidia.ts");
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

describe("installNvidiaRuntimeClass (Task 4, talos-only)", () => {
  test("creates a RuntimeClass named 'nvidia' with the nvidia containerd handler", async () => {
    const res = nvidia.installNvidiaRuntimeClass({ provider: provider() });
    const meta = await get<{ name: string }>(res.runtimeClass, "metadata");
    const handler = await get<string>(res.runtimeClass, "handler");
    expect(meta.name).toBe("nvidia");
    expect(handler).toBe("nvidia");
  });

  test("NVIDIA_RUNTIME_CLASS_NAME is the single source services.ts/homeassistant.ts consume", () => {
    expect(nvidia.NVIDIA_RUNTIME_CLASS_NAME).toBe("nvidia");
  });
});
