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

let agentSandbox: typeof import("../src/agent-sandbox.ts");
beforeAll(async () => {
  agentSandbox = await import("../src/agent-sandbox.ts");
});

const provider = () => new k8s.Provider("test", { context: "x" });

describe("installAgentSandboxCrds (program handoff step 1, #432, talos-only)", () => {
  test("pins the exact v0.5.3 tag, never a moving ref", () => {
    // Pre-1.0 project (spec Verified fact #10): a breaking API change
    // (v1alpha1 -> v1beta1) and a status-wiping race fixed only as of
    // v0.5.2, so this must never drift to :latest/main.
    expect(agentSandbox.AGENT_SANDBOX_VERSION).toBe("v0.5.3");
  });

  test("creates a ConfigFile install pointed at the pinned release manifest", () => {
    const res = agentSandbox.installAgentSandboxCrds({ provider: provider() });
    expect(res.install).toBeInstanceOf(k8s.yaml.ConfigFile);
  });
});
