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

let cnpg: typeof import("../src/cnpg.ts");
let cm: typeof import("../src/certmanager.ts");
beforeAll(async () => {
  cnpg = await import("../src/cnpg.ts");
  cm = await import("../src/certmanager.ts");
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

// Mock vault with the postgres password CNPG uses (CC-k8t7). CAPTIVE_PORTAL_*
// is gone from the mock too , cnpg.ts no longer reads it (SDD track 0, Task 6
// removed the captive-portal CNPG cluster + namespace).
const mockVault: Record<string, string> = {
  CONTROL_CENTER_POSTGRES__PASSWORD: "mock-cc-pw",
  SOFTWARE_FACTORY_POSTGRES__PASSWORD: "mock-software-factory-pw",
};

const testNamespaces = {
  "control-center": "control-center",
  "dont-text-your-ex": "dont-text-your-ex",
  "software-factory": "software-factory",
  cloudflare: "cloudflare",
} as const;

describe("installCnpg", () => {
  test("single-instance Cluster on local-lvm with the www-ke9a 768M cap, bridged credential", async () => {
    const res = cnpg.installCnpg({
      provider: provider(),
      namespaces: testNamespaces,
      operatorVersion: "1.29.1",
      vault: mockVault,
    });
    const spec = await get<{
      instances: number;
      storage: { storageClass: string };
      resources: { limits: { memory: string }; requests: { memory: string; cpu: string } };
      bootstrap: { initdb: { database: string; owner: string; secret: { name: string } } };
      superuserSecret: { name: string };
    }>(res.cluster, "spec");
    expect(spec.instances).toBe(1);
    expect(spec.storage.storageClass).toBe("local-lvm");
    expect(spec.resources.limits.memory).toBe("768Mi");
    expect(spec.resources.requests.cpu).toBe("500m");
    // #87: CPU limits are banned — DatabaseResources.limits has no `cpu` key
    // at the type level, so this just pins that nothing smuggles one in via a
    // widened cast.
    expect((spec.resources.limits as Record<string, string>).cpu).toBeUndefined();
    // Bridged password: both refs point at the same native basic-auth secret.
    expect(spec.bootstrap.initdb.database).toBe("control_center");
    expect(spec.bootstrap.initdb.owner).toBe("postgres");
    expect(spec.bootstrap.initdb.secret.name).toBe(spec.superuserSecret.name);
  });

  test("the auth Secret is kubernetes.io/basic-auth with username=postgres (CC-k8t7)", async () => {
    const res = cnpg.installCnpg({
      provider: provider(),
      namespaces: testNamespaces,
      operatorVersion: "1.29.1",
      vault: mockVault,
    });
    const type = await get<string>(res.authSecret, "type");
    const stringData = await get<{ username: string }>(res.authSecret, "stringData");
    expect(type).toBe("kubernetes.io/basic-auth");
    expect(stringData.username).toBe("postgres");
  });

  test("installs the two declared product databases", async () => {
    const res = cnpg.installCnpg({
      provider: provider(),
      namespaces: testNamespaces,
      operatorVersion: "1.29.1",
      vault: mockVault,
    });

    expect(res.clusters).toHaveLength(2);
    expect(res.authSecrets).toHaveLength(2);

    const clusterSpecs = await Promise.all(
      res.clusters.map((cluster) =>
        get<{ bootstrap: { initdb: { database: string } } }>(cluster, "spec"),
      ),
    );
    expect(clusterSpecs.map((spec) => spec.bootstrap.initdb.database)).toEqual([
      "control_center",
      "software_factory",
    ]);
  });

  test("creates the control-center database resources in its owning namespace", async () => {
    const res = cnpg.installCnpg({
      provider: provider(),
      namespaces: testNamespaces,
      operatorVersion: "1.29.1",
      vault: mockVault,
    });

    const clusterMetadata = await Promise.all(
      res.clusters.map((cluster) => get<{ name: string; namespace: string }>(cluster, "metadata")),
    );
    const secretMetadata = await Promise.all(
      res.authSecrets.map((secret) => get<{ name: string; namespace: string }>(secret, "metadata")),
    );

    expect(clusterMetadata.find((m) => m.name === "control-center-postgres")?.namespace).toBe(
      "control-center",
    );
    expect(secretMetadata.find((m) => m.name === "cc-postgres-auth")?.namespace).toBe(
      "control-center",
    );
    expect(clusterMetadata.find((m) => m.name === "software-factory-postgres")?.namespace).toBe(
      "software-factory",
    );
    expect(secretMetadata.find((m) => m.name === "software-factory-postgres-auth")?.namespace).toBe(
      "software-factory",
    );
  });
});

describe("installCertManager", () => {
  test("the CF-token Secret lives in the cert-manager namespace, not the app ns", async () => {
    const res = cm.installCertManager({
      provider: provider(),
      version: "v1.20.2",
      vault: { CLOUDFLARE_API__CREDENTIAL: "test-token" },
    });
    const meta = await get<{ namespace: string }>(res.cfTokenSecret, "metadata");
    // ClusterIssuer solver reads its token from the controller's namespace.
    expect(meta.namespace).toBe("cert-manager");
  });

  test("the ClusterIssuer is DNS-01 via Cloudflare, no email when unset", async () => {
    const res = cm.installCertManager({
      provider: provider(),
      version: "v1.20.2",
      vault: { CLOUDFLARE_API__CREDENTIAL: "test-token" },
    });
    const spec = await get<{
      acme: { email?: string; solvers: { dns01: { cloudflare: unknown } }[] };
    }>(res.issuer, "spec");
    expect(spec.acme.solvers[0].dns01.cloudflare).toBeDefined();
    expect(spec.acme.email).toBeUndefined();
  });

  // Regression (SDD track 0, Task 6): installCertManager() used to also issue
  // the portal Certificate directly, in the (now-deleted) captive-portal
  // namespace. issuePortalCertificate() is now the only source of a portal
  // Certificate; this pins that it still covers the captive-portal LAN host,
  // reusing the shared issuer installCertManager() returns. (The abandoned
  // app--cp SAN was dropped in Task 7 Step C.)
  test("issuePortalCertificate covers the captive-portal LAN host", async () => {
    const cmRes = cm.installCertManager({
      provider: provider(),
      version: "v1.20.2",
      vault: { CLOUDFLARE_API__CREDENTIAL: "test-token" },
    });
    const certificate = cm.issuePortalCertificate({
      provider: provider(),
      namespace: "control-center",
      issuer: cmRes.issuer,
      resourceName: "control-center-guest-tls",
    });
    const meta = await get<{ namespace: string }>(certificate, "metadata");
    const spec = await get<{ dnsNames: string[]; secretName: string }>(certificate, "spec");
    expect(meta.namespace).toBe("control-center");
    expect(spec.dnsNames).toEqual(["captive-portal.worldwidewebb.co"]);
    expect(spec.dnsNames).not.toContain("app--cp.worldwidewebb.co");
    expect(spec.secretName).toBe("captive-portal-tls");
  });
});
