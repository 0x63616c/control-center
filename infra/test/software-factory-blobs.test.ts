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
beforeAll(async () => {
  softwareFactory = await import("../src/software-factory.ts");
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

const vault = {
  GITHUB_PERSONAL_ACCESS_TOKEN__TOKEN: "mock-ghcr-pat",
  GITHUB_BOT_APP__APP_ID: "1",
  GITHUB_BOT_APP__INSTALLATION_ID: "2",
  GITHUB_BOT_APP__PRIVATE_KEY_PEM: "mock-base64-pem",
  SOFTWARE_FACTORY_POSTGRES__PASSWORD: "mock-postgres-password",
  SOFTWARE_FACTORY_API__WORKER_BEARER_TOKEN: "mock-worker-bearer",
  SOFTWARE_FACTORY_API__SANDBOX_BEARER_TOKEN: "mock-run-worker-bearer",
  SOFTWARE_FACTORY_CLOUDFLARE_ACCESS__TEAM_DOMAIN: "example.cloudflareaccess.com",
  GITHUB_BOT_APP__WEBHOOK_SECRET: "mock-webhook-secret",
};

const digests = {
  "software-factory-worker": `sha256:${"a".repeat(64)}`,
  "software-factory-run-worker": `sha256:${"1".repeat(64)}`,
  "software-factory-relay": `sha256:${"c".repeat(64)}`,
  "software-factory-api": `sha256:${"d".repeat(64)}`,
  "software-factory-console": `sha256:${"e".repeat(64)}`,
  "software-factory-blobs": `sha256:${"f".repeat(64)}`,
  "software-factory-codec": `sha256:${"0".repeat(64)}`,
};

const namespace = new k8s.core.v1.Namespace("software-factory-blobs-test-namespace", {
  metadata: { name: "software-factory" },
});

function install() {
  return softwareFactory.installSoftwareFactory({
    provider: new k8s.Provider("software-factory-blobs-test-provider", { context: "x" }),
    namespace,
    vault,
    accessAud: "mock-audience",
    imageDigests: digests,
    nasNfsServer: "192.168.0.218",
    requireImageDigestPins: false,
  });
}

interface VolumeMount {
  name: string;
  mountPath: string;
  subPath?: string;
}

interface DeploymentSpec {
  replicas: number;
  template: {
    spec: {
      containers: {
        env: { name: string; value?: string }[];
        readinessProbe?: { httpGet?: { path: string; port: string | number } };
        volumeMounts?: VolumeMount[];
      }[];
      volumes?: { name: string; persistentVolumeClaim?: { claimName: string } }[];
    };
  };
}

describe("software factory payload blob infrastructure", () => {
  test("uses a capacity-named, statically bound RWX blob PVC", async () => {
    const resources = install();
    const [metadata, volume, claim] = await Promise.all([
      get<{ name: string }>(resources.blobsVolume, "metadata"),
      get<{ accessModes: string[]; storageClassName: string }>(resources.blobsVolume, "spec"),
      get<{ accessModes: string[]; storageClassName: string }>(resources.blobsClaim, "spec"),
    ]);

    expect(metadata.name).toMatch(/^software-factory-blobs-\d+gi$/);
    expect(volume.accessModes).toEqual(["ReadWriteMany"]);
    expect(volume.storageClassName).toBe("");
    expect(claim.accessModes).toEqual(["ReadWriteMany"]);
    expect(claim.storageClassName).toBe("");
  });

  test("runs two ready blob replicas with the PVC subpath and a volume-free codec", async () => {
    const resources = install();
    const [blobs, codec] = await Promise.all([
      get<DeploymentSpec>(resources.blobs, "spec"),
      get<DeploymentSpec>(resources.codec, "spec"),
    ]);
    const blobContainer = blobs.template.spec.containers[0];

    expect(blobs.replicas).toBe(2);
    expect(blobContainer?.readinessProbe?.httpGet).toEqual({ path: "/healthz", port: "http" });
    expect(blobContainer?.volumeMounts).toContainEqual({
      name: "blobs",
      mountPath: "/blobs",
      subPath: "software-factory/blobs",
    });
    expect(blobs.template.spec.volumes).toContainEqual({
      name: "blobs",
      persistentVolumeClaim: { claimName: "software-factory-blobs-100gi" },
    });
    expect(codec.template.spec.volumes).toBeUndefined();
    expect(codec.template.spec.containers[0]?.volumeMounts).toBeUndefined();
  });

  test("allows browser codec requests only from the Temporal UI origin", async () => {
    const codec = await get<DeploymentSpec>(install().codec, "spec");
    const corsOrigins = codec.template.spec.containers[0]?.env.find(
      (env) => env.name === "CODEC_CORS_ORIGINS",
    )?.value;

    expect(corsOrigins).toContain("https://temporal-ui.worldwidewebb.co");
    expect(corsOrigins).not.toBe("*");
  });

  test("wires the in-namespace blob URL into the worker", async () => {
    const worker = await get<DeploymentSpec>(install().worker, "spec");
    expect(worker.template.spec.containers[0]?.env).toContainEqual({
      name: "BLOBS_URL",
      value: "http://blobs:8080",
    });
  });
});
