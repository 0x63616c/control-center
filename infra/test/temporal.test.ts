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
  TEMPORAL_POSTGRES__PASSWORD: "mock-temporal-postgres-password",
  CONTROL_CENTER_POSTGRES__PASSWORD: "mock-cc-postgres-password",
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
  ports?: { name: string; containerPort: number }[];
  resources?: unknown;
}
interface PodSpec {
  containers: ContainerSpec[];
  imagePullSecrets?: { name: string }[];
}
interface DeploymentSpec {
  replicas: number;
  selector: { matchLabels: Record<string, string> };
  template: {
    metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> };
    spec: PodSpec;
  };
}
interface ServiceSpec {
  ports: { name: string; port: number; targetPort: number }[];
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

  test("the app owner's server-facing credential is untouched by the superuser secret (#65)", async () => {
    const spec = await get<DeploymentSpec>(install().server, "spec");
    const pwd = spec.template.spec.containers[0].env?.find((e) => e.name === "POSTGRES_PWD");
    expect(pwd?.valueFrom).toEqual({
      secretKeyRef: { name: "temporal-postgres-app", key: "password" },
    });
  });

  test("the postgres superuser gets a vault-sourced Secret so pgAdmin/db-ui has a durable credential (#65)", async () => {
    const res = install();
    const type = await get<string>(res.authSecret, "type");
    const stringData = await get<{ username: string; password: string }>(
      res.authSecret,
      "stringData",
    );
    const meta = await get<{ name: string; namespace: string }>(res.authSecret, "metadata");
    expect(type).toBe("kubernetes.io/basic-auth");
    expect(stringData.username).toBe("postgres");
    expect(stringData.password).toBe("mock-temporal-postgres-password");
    expect(meta.name).toBe("temporal-postgres-auth");
    expect(meta.namespace).toBe("temporal");
  });

  test("the CNPG cluster enables superuser access, keyed to the vault-sourced Secret (#65)", async () => {
    const res = install();
    const spec = await get<{
      enableSuperuserAccess: boolean;
      superuserSecret: { name: string };
    }>(res.cluster, "spec");
    expect(spec.enableSuperuserAccess).toBe(true);
    expect(spec.superuserSecret).toEqual({ name: "temporal-postgres-auth" });
  });

  test("throws when the vault is missing TEMPORAL_POSTGRES__PASSWORD", () => {
    expect(() =>
      temporal.installTemporal({
        provider: provider(),
        cnpgOperator: cnpgOperator(),
        vault: { GITHUB_PERSONAL_ACCESS_TOKEN__TOKEN: "mock-ghcr-pat" },
        imageDigests: {},
      }),
    ).toThrow(/TEMPORAL_POSTGRES__PASSWORD/);
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

  test("the worker declares APP_ENV=production so its prod logs are not stamped 'development'", async () => {
    const spec = await get<DeploymentSpec>(install().worker, "spec");
    const env = spec.template.spec.containers[0].env ?? [];
    expect(env.find((e) => e.name === "APP_ENV")?.value).toBe("production");
  });

  test("the UI accepts the tunnel hostname as a CORS origin, not just port-forward localhost", async () => {
    const spec = await get<DeploymentSpec>(install().ui, "spec");
    const cors = spec.template.spec.containers[0].env?.find(
      (e) => e.name === "TEMPORAL_CORS_ORIGINS",
    );
    // Hostname comes from the platform manifest, so the tunnel route, the
    // Access app and this CORS allowlist cannot drift apart.
    expect(cors?.value).toBe("https://temporal-ui.worldwidewebb.co,http://localhost:8080");
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

  // Issue #215. Prometheus metrics are only reachable if ALL of these line up:
  // the env var that makes the server open the listener at all, the container
  // port, the Service port, and the pod annotations the scrape job discovers.
  // Any one missing yields metrics that exist but are never collected.
  describe("prometheus metrics endpoint (issue #215)", () => {
    test("PROMETHEUS_ENDPOINT binds 0.0.0.0 so the listener is reachable outside the container", async () => {
      const spec = await get<DeploymentSpec>(install().server, "spec");
      const container = spec.template.spec.containers[0];
      // The 1.31.x config template renders this value straight into
      // global.metrics.prometheus.listenAddress; localhost would bind the
      // listener where no scraper can reach it.
      expect(envValue(container, "PROMETHEUS_ENDPOINT")).toBe("0.0.0.0:9090");
      // The template's chain is `if STATSD_ENDPOINT / else if
      // PROMETHEUS_ENDPOINT`, so a STATSD_ENDPOINT here would silently win and
      // leave the prometheus block unrendered.
      expect(container.env?.map((e) => e.name)).not.toContain("STATSD_ENDPOINT");
    });

    test("the metrics port is declared on the container, without colliding with grpc/http", async () => {
      const spec = await get<DeploymentSpec>(install().server, "spec");
      const ports = spec.template.spec.containers[0].ports ?? [];
      expect(ports).toContainEqual({ name: "metrics", containerPort: 9090 });
      expect(ports.map((p) => p.containerPort)).toEqual([7233, 7243, 9090]);
    });

    test("the temporal-server Service exposes the metrics port", async () => {
      const spec = await get<ServiceSpec>(install().serverService, "spec");
      expect(spec.ports).toContainEqual({ name: "metrics", port: 9090, targetPort: 9090 });
    });

    test("scrape annotations sit on the POD template, so both replicas are discovered separately", async () => {
      const res = install();
      const spec = await get<DeploymentSpec>(res.server, "spec");
      expect(spec.template.metadata?.annotations).toEqual({
        "prometheus.io/scrape": "true",
        "prometheus.io/port": "9090",
        "prometheus.io/path": "/metrics",
      });
      // Annotations on the Deployment itself would discover nothing: pod
      // discovery reads the pods', and each of the 2 replicas runs all four
      // roles and therefore reports its own distinct series.
      expect(spec.replicas).toBe(2);
      const deploymentMeta = await get<{ annotations?: Record<string, string> }>(
        res.server,
        "metadata",
      );
      expect(deploymentMeta.annotations?.["prometheus.io/scrape"]).toBeUndefined();
    });
  });

  test("server, UI and worker are named exactly as the ask asked", async () => {
    const res = install();
    const names = await Promise.all(
      [res.server, res.ui, res.worker].map((d) => get<{ name: string }>(d, "metadata")),
    );
    expect(names.map((m) => m.name)).toEqual(["temporal-server", "temporal-ui", "temporal-worker"]);
  });

  // Issue #233. The worker's SDK-internal metrics (Runtime.install's
  // telemetryOptions.metrics.otel) go to this collector over OTLP/gRPC, which
  // re-exports to its OWN Prometheus port for the existing generic
  // `kubernetes-pods` scrape job — no dedicated scrape job is added.
  describe("temporal-otel-collector (issue #233)", () => {
    test("is pinned to the contrib image, since the Prometheus exporter only ships there", async () => {
      const spec = await get<DeploymentSpec>(install().otelCollector, "spec");
      expect(spec.template.spec.containers[0].image).toBe(
        "otel/opentelemetry-collector-contrib:0.157.0",
      );
    });

    test("exposes an OTLP/gRPC receiver port for the worker to dial", async () => {
      const spec = await get<DeploymentSpec>(install().otelCollector, "spec");
      const ports = spec.template.spec.containers[0].ports ?? [];
      expect(ports).toContainEqual({ name: "otlp-grpc", containerPort: 4317 });
    });

    test("exposes its OWN Prometheus-exporter port, distinct from the server's and worker's", async () => {
      const spec = await get<DeploymentSpec>(install().otelCollector, "spec");
      const ports = spec.template.spec.containers[0].ports ?? [];
      expect(ports).toContainEqual({ name: "metrics", containerPort: 9464 });
    });

    test("scrape annotations sit on the POD template, pointed at its own Prometheus port", async () => {
      const spec = await get<DeploymentSpec>(install().otelCollector, "spec");
      expect(spec.template.metadata?.annotations).toEqual({
        "prometheus.io/scrape": "true",
        "prometheus.io/port": "9464",
        "prometheus.io/path": "/metrics",
      });
      const deploymentMeta = await get<{ annotations?: Record<string, string> }>(
        install().otelCollector,
        "metadata",
      );
      expect(deploymentMeta.annotations?.["prometheus.io/scrape"]).toBeUndefined();
    });

    test("the collector config is a ConfigMap wiring an OTLP receiver to a Prometheus exporter", async () => {
      const res = install();
      const data = await get<Record<string, string>>(res.otelCollectorConfig, "data");
      const config = data["config.yaml"];
      expect(config).toContain("otlp:");
      expect(config).toContain("0.0.0.0:4317");
      expect(config).toContain("prometheus:");
      expect(config).toContain("0.0.0.0:9464");
    });

    test("the Service exposes only the OTLP port — no Service needed for the scrape, which is pod-IP direct", async () => {
      const spec = await get<ServiceSpec>(install().otelCollectorService, "spec");
      expect(spec.ports).toEqual([{ name: "otlp-grpc", port: 4317, targetPort: 4317 }]);
    });

    test("the collector Deployment/Service/ConfigMap depend on the namespace, in the right order", async () => {
      const res = install();
      const configMeta = await get<{ namespace: string }>(res.otelCollectorConfig, "metadata");
      const deploymentMeta = await get<{ namespace: string }>(res.otelCollector, "metadata");
      const serviceMeta = await get<{ namespace: string }>(res.otelCollectorService, "metadata");
      expect(configMeta.namespace).toBe("temporal");
      expect(deploymentMeta.namespace).toBe("temporal");
      expect(serviceMeta.namespace).toBe("temporal");
    });

    test("carries no GHCR pull secret — the contrib image is public, unlike the worker's", async () => {
      const spec = await get<DeploymentSpec>(install().otelCollector, "spec");
      expect(spec.template.spec.imagePullSecrets ?? []).toEqual([]);
    });
  });
});
