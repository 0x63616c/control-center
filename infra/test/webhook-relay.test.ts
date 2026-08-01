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

let webhookRelay: typeof import("../src/webhook-relay.ts");
beforeAll(async () => {
  webhookRelay = await import("../src/webhook-relay.ts");
});

function get<T>(resource: pulumi.Resource, property: string): Promise<T> {
  const output = (resource as unknown as Record<string, pulumi.Output<T>>)[property];
  return new Promise((resolve) => {
    output.apply((value) => {
      resolve(value);
      return value;
    });
  });
}

function install() {
  return webhookRelay.installWebhookRelay({
    provider: new k8s.Provider("webhook-relay-test", { context: "x" }),
    vault: {
      GITHUB_PERSONAL_ACCESS_TOKEN__TOKEN: "mock-pull-token",
      GITHUB_BOT_APP__WEBHOOK_SECRET: "mock-webhook-secret",
    },
    imageDigests: { "software-factory-relay": `sha256:${"a".repeat(64)}` },
    requireImageDigestPins: false,
  });
}

describe("installWebhookRelay", () => {
  test("creates the isolated relay namespace and service contract", async () => {
    const resources = install();
    expect((await get<{ name: string }>(resources.namespace, "metadata")).name).toBe(
      "webhook-relay",
    );
    expect(
      (await get<{ ports: { port: number }[] }>(resources.service, "spec")).ports[0]?.port,
    ).toBe(8080);
  });

  test("forwards to control-center and the factory, and reads the secret by reference", async () => {
    const spec = await get<{
      template: {
        spec: {
          automountServiceAccountToken: boolean;
          containers: {
            image: string;
            env: { name: string; value?: string; valueFrom?: unknown }[];
            securityContext: unknown;
          }[];
        };
      };
    }>(install().relay, "spec");
    const container = spec.template.spec.containers[0];
    expect(container.image).toBe(
      `ghcr.io/0x63616c/software-factory-relay@sha256:${"a".repeat(64)}`,
    );
    expect(spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(container.env.find((value) => value.name === "RELAY_TARGETS")?.value).toBe(
      JSON.stringify([
        {
          name: "control-center",
          url: "http://api.control-center.svc.cluster.local:4201/hooks/github",
        },
        {
          name: "software-factory",
          url: "http://api.software-factory.svc.cluster.local:8080/v1/hooks/github",
        },
      ]),
    );
    expect(
      container.env.find((value) => value.name === "GITHUB_BOT_APP__WEBHOOK_SECRET")?.valueFrom,
    ).toEqual({
      secretKeyRef: { name: "webhook-relay-secrets", key: "GITHUB_BOT_APP__WEBHOOK_SECRET" },
    });
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
  });
});
