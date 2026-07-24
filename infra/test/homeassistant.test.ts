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

let ha: typeof import("../src/homeassistant.ts");
beforeAll(async () => {
  ha = await import("../src/homeassistant.ts");
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
// Same manifest URL cnpg.ts's real installCnpg() fetches (cnpg-certmanager.test.ts's
// proven-working network path) , a made-up unreachable host would fail DNS
// resolution and surface as an unhandled rejection outside any test's control flow.
const cnpgOperator = () =>
  new k8s.yaml.ConfigFile("cnpg-operator-test", {
    file: "https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.29/releases/cnpg-1.29.1.yaml",
  });

const mockVault: Record<string, string> = {
  HOME_ASSISTANT_POSTGRES__PASSWORD: "mock-ha-pg-pw",
};

function install() {
  return ha.installHomeAssistant({
    provider: provider(),
    cnpgOperator: cnpgOperator(),
    vault: mockVault,
    nasNfsServer: "192.168.0.218",
  });
}

describe("installHomeAssistant (Task 4, §0.1-§0.4, talos-only)", () => {
  test("creates its own 'home-assistant' namespace (L1: outside InfraNamespaceName)", async () => {
    const res = install();
    const meta = await get<{ name: string }>(res.namespace, "metadata");
    expect(meta.name).toBe(ha.HOME_ASSISTANT_NAMESPACE);
    expect(ha.HOME_ASSISTANT_NAMESPACE).toBe("home-assistant");
  });

  test("§0.1: a SEPARATE CNPG Cluster (db home_assistant), not a 2nd db in control-center", async () => {
    const res = install();
    const spec = await get<{
      instances: number;
      bootstrap: { initdb: { database: string; owner: string } };
      storage: { storageClass: string };
    }>(res.cluster, "spec");
    expect(spec.instances).toBe(1);
    expect(spec.bootstrap.initdb.database).toBe("home_assistant");
    expect(spec.storage.storageClass).toBe("local-path");
  });

  test("the CNPG cluster lives in the home-assistant namespace, not control-center", async () => {
    const res = install();
    const meta = await get<{ namespace: string }>(res.cluster, "metadata");
    expect(meta.namespace).toBe("home-assistant");
  });

  test("the auth Secret is kubernetes.io/basic-auth (bridged credential, cnpg.ts's pattern)", async () => {
    const res = install();
    const type = await get<string>(res.authSecret, "type");
    const stringData = await get<{ username: string }>(res.authSecret, "stringData");
    expect(type).toBe("kubernetes.io/basic-auth");
    expect(stringData.username).toBe("postgres");
  });

  test("throws when the vault is missing HOME_ASSISTANT_POSTGRES__PASSWORD", () => {
    expect(() =>
      ha.installHomeAssistant({
        provider: provider(),
        cnpgOperator: cnpgOperator(),
        vault: {},
        nasNfsServer: "192.168.0.218",
      }),
    ).toThrow(/HOME_ASSISTANT_POSTGRES__PASSWORD/);
  });

  test("§0.3: the ha-config PVC is a small (5Gi) local-path claim", async () => {
    const res = install();
    const spec = await get<{
      storageClassName: string;
      resources: { requests: { storage: string } };
    }>(res.configClaim, "spec");
    expect(spec.storageClassName).toBe("local-path");
    expect(spec.resources.requests.storage).toBe("5Gi");
  });

  test("the HA Deployment is hostNetwork + ClusterFirstWithHostNet + the nvidia RuntimeClass", async () => {
    const res = install();
    const spec = await get<{
      template: {
        spec: { hostNetwork?: boolean; dnsPolicy?: string; runtimeClassName?: string };
      };
    }>(res.workload.deployment, "spec");
    expect(spec.template.spec.hostNetwork).toBe(true);
    expect(spec.template.spec.dnsPolicy).toBe("ClusterFirstWithHostNet");
    expect(spec.template.spec.runtimeClassName).toBe("nvidia");
  });

  test("the HA Deployment mounts /config from the ha-config claim", async () => {
    const res = install();
    const spec = await get<{
      template: { spec: { containers: { volumeMounts: { mountPath: string }[] }[] } };
    }>(res.workload.deployment, "spec");
    const mounts = spec.template.spec.containers[0].volumeMounts.map((m) => m.mountPath);
    expect(mounts).toContain("/config");
  });

  test("§0.4: does not create anything in the control-center namespace", async () => {
    const res = install();
    const namespacesUsed = await Promise.all([
      get<{ namespace: string }>(res.cluster, "metadata").then((m) => m.namespace),
      get<{ namespace: string }>(res.authSecret, "metadata").then((m) => m.namespace),
      get<{ namespace: string }>(res.configClaim, "metadata").then((m) => m.namespace),
    ]);
    expect(namespacesUsed.every((ns) => ns === "home-assistant")).toBe(true);
  });

  test("declares exactly two backup crons: ha-config tar + home_assistant pg_dump", async () => {
    const res = install();
    expect(res.backupJobs).toHaveLength(2);
    const names = await Promise.all(
      res.backupJobs.map((j) => get<{ name: string }>(j.cronJob, "metadata").then((m) => m.name)),
    );
    expect(names.sort()).toEqual(["ha-config-backup", "home-assistant-pg-backup"]);
  });
});
