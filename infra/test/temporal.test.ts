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

let temporal: typeof import("../src/temporal.ts");
beforeAll(async () => {
  temporal = await import("../src/temporal.ts");
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
// Same manifest URL the real installCnpg() fetches (homeassistant.test.ts's
// proven-working network path); an unreachable host would fail DNS resolution
// as an unhandled rejection outside any test's control flow.
const cnpgOperator = () =>
  new k8s.yaml.ConfigFile("cnpg-operator-temporal-test", {
    file: "https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.29/releases/cnpg-1.29.1.yaml",
  });

const mockVault: Record<string, string> = {
  GITHUB_PERSONAL_ACCESS_TOKEN__TOKEN: "mock-ghcr-pat",
};

function install(imageDigests: Record<string, string> = {}) {
  return temporal.installTemporal({
    provider: provider(),
    cnpgOperator: cnpgOperator(),
    vault: mockVault,
    imageDigests,
  });
}

interface ContainerSpec {
  image: string;
  env?: { name: string; value?: string; valueFrom?: unknown }[];
  command?: string[];
  resources?: unknown;
}
interface PodSpec {
  containers: ContainerSpec[];
  imagePullSecrets?: { name: string }[];
}
interface DeploymentSpec {
  replicas: number;
  selector: { matchLabels: Record<string, string> };
  template: { spec: PodSpec };
}

const envValue = (container: ContainerSpec, name: string) =>
  container.env?.find((e) => e.name === name)?.value;

describe("installTemporal (issue #124, talos-only)", () => {
  test("creates its own 'temporal' namespace (outside InfraNamespaceName)", async () => {
    const meta = await get<{ name: string }>(install().namespace, "metadata");
    expect(meta.name).toBe("temporal");
    expect(temporal.TEMPORAL_NAMESPACE).toBe("temporal");
  });

  test("runs TWO temporal-server replicas, as the ask requires", async () => {
    const spec = await get<DeploymentSpec>(install().server, "spec");
    expect(spec.replicas).toBe(2);
  });

  test("server runs all four roles in ONE process, per the ask", async () => {
    const spec = await get<DeploymentSpec>(install().server, "spec");
    expect(envValue(spec.template.spec.containers[0], "SERVICES")).toBe(
      "frontend:history:matching:worker",
    );
  });

  test("both stores are Postgres: `temporal` and `temporal_visibility`", async () => {
    const res = install();
    const container = (await get<DeploymentSpec>(res.server, "spec")).template.spec.containers[0];
    expect(envValue(container, "DB")).toBe("postgres12");
    expect(envValue(container, "DBNAME")).toBe("temporal");
    expect(envValue(container, "VISIBILITY_DBNAME")).toBe("temporal_visibility");

    // …and the visibility database is actually CREATED, since initdb makes one.
    const cluster = await get<{
      spec: { bootstrap: { initdb: { database: string; postInitSQL: string[] } } };
    }>(res.cluster, "spec");
    const initdb = (cluster as unknown as { bootstrap: { initdb: Record<string, unknown> } })
      .bootstrap.initdb;
    expect(initdb.database).toBe("temporal");
    expect((initdb.postInitSQL as string[]).join(" ")).toContain(
      "CREATE DATABASE temporal_visibility",
    );
  });

  test("the DB password is never a literal — it comes from the CNPG-managed Secret", async () => {
    const spec = await get<DeploymentSpec>(install().server, "spec");
    const pwd = spec.template.spec.containers[0].env?.find((e) => e.name === "POSTGRES_PWD");
    expect(pwd?.value).toBeUndefined();
    expect(pwd?.valueFrom).toEqual({
      secretKeyRef: { name: "temporal-postgres-app", key: "password" },
    });
  });

  test("BIND_ON_IP / TEMPORAL_BROADCAST_ADDRESS stay unset so each replica broadcasts its own pod IP", async () => {
    const spec = await get<DeploymentSpec>(install().server, "spec");
    const names = spec.template.spec.containers[0].env?.map((e) => e.name) ?? [];
    expect(names).not.toContain("BIND_ON_IP");
    expect(names).not.toContain("TEMPORAL_BROADCAST_ADDRESS");
  });

  test("schema setup is its own Job, not auto-setup racing inside two server pods", async () => {
    const res = install();
    const meta = await get<{ name: string }>(res.schemaJob, "metadata");
    expect(meta.name).toMatch(/^temporal-schema-setup-/);
    const spec = await get<{ template: { spec: PodSpec } }>(res.schemaJob, "spec");
    const script = spec.template.spec.containers[0].command?.join("\n") ?? "";
    // update-schema must NOT be tolerated failing — a broken migration has to
    // fail the deploy rather than leave the server crash-looping.
    expect(script).toContain("update-schema -d /etc/temporal/schema/postgresql/v12/temporal");
    expect(script).toContain(
      "update-schema -d /etc/temporal/schema/postgresql/v12/visibility/versioned",
    );
    expect(script).not.toMatch(/update-schema[^\n]*\|\| true/);
  });

  test("waits for postgres with a bounded TCP probe, never a temporal-sql-tool subcommand", async () => {
    const spec = await get<{ template: { spec: PodSpec } }>(install().schemaJob, "spec");
    const script = spec.template.spec.containers[0].command?.join("\n") ?? "";
    // `temporal-sql-tool` 1.31.2 has no `ping`: setup-schema, update-schema,
    // create-database and drop-database are the only subcommands. An
    // `until … ping` gate therefore never succeeds and the Job hangs Running
    // forever against a perfectly healthy database.
    expect(script).not.toContain("ping");
    expect(script).toContain("nc -z temporal-postgres-rw 5432");
    // Bounded: unreachable Postgres must fail the Job, not hang it.
    expect(script).toContain("exit 1");
    expect(script).toMatch(/attempt.*-ge \d+/);
  });

  test("registers the control-center Temporal namespace, and fails the Job if it is absent", async () => {
    const spec = await get<{ template: { spec: PodSpec } }>(install().namespaceJob, "spec");
    const script = spec.template.spec.containers[0].command?.join("\n") ?? "";
    expect(script).toContain("namespace create --namespace control-center");
    // `describe` is the assertion: create may legitimately say AlreadyExists.
    expect(script).toMatch(/namespace describe --namespace control-center\s*$/);
    expect(temporal.TEMPORAL_CLUSTER_NAMESPACE).toBe("control-center");
  });

  test("the worker image is digest-pinned through the shared imageDigests map", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const spec = await get<DeploymentSpec>(
      install({ "control-center-temporal-worker": digest }).worker,
      "spec",
    );
    expect(spec.template.spec.containers[0].image).toBe(
      `ghcr.io/0x63616c/www-control-center-temporal-worker@${digest}`,
    );
    expect(spec.template.spec.imagePullSecrets).toEqual([{ name: "ghcr-pull" }]);
  });

  test("server, UI and worker are named exactly as the ask asked", async () => {
    const res = install();
    const names = await Promise.all(
      [res.server, res.ui, res.worker].map((d) => get<{ name: string }>(d, "metadata")),
    );
    expect(names.map((m) => m.name)).toEqual(["temporal-server", "temporal-ui", "temporal-worker"]);
  });
});
