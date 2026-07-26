import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, test } from "vitest";
import * as yaml from "yaml";

pulumi.runtime.setMocks({
  newResource(args: pulumi.runtime.MockResourceArgs) {
    return { id: `${args.name}-id`, state: args.inputs };
  },
  call() {
    return {};
  },
});

let loki: typeof import("../src/observability/loki.ts");
let alloy: typeof import("../src/observability/alloy.ts");
beforeAll(async () => {
  loki = await import("../src/observability/loki.ts");
  alloy = await import("../src/observability/alloy.ts");
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

const provider = () => new k8s.Provider("logging-test", { context: "x" });
const namespace = () =>
  new k8s.core.v1.Namespace("observability-logging-test", {
    metadata: { name: "observability" },
  });

const installLoki = () => loki.installLoki({ provider: provider(), namespace: namespace() });
const installAlloy = () => alloy.installAlloy({ provider: provider(), namespace: namespace() });

interface LokiConfig {
  schema_config: {
    configs: { from: string; store: string; object_store: string; schema: string }[];
  };
  compactor: {
    retention_enabled: boolean;
    delete_request_store: string;
    working_directory: string;
  };
  limits_config: { retention_period: string; reject_old_samples: boolean };
  common: { path_prefix: string; replication_factor: number };
}

async function lokiConfig(): Promise<LokiConfig> {
  const data = await get<Record<string, string>>(installLoki().config, "data");
  return yaml.parse(data["config.yaml"]) as LokiConfig;
}

async function alloyConfig(): Promise<string> {
  const data = await get<Record<string, string>>(installAlloy().config, "data");
  return data["config.alloy"];
}

interface PodSpec {
  containers: { image: string; args?: string[]; resources?: { limits?: Record<string, string> } }[];
  securityContext?: { fsGroup?: number };
}

describe("installLoki (issue #216)", () => {
  test("the index is tsdb at schema v13, not the legacy boltdb-shipper/v11/v12", async () => {
    const config = await lokiConfig();
    // boltdb-shipper still parses in Loki 3.x, which is exactly why this is
    // worth asserting: getting it wrong is silent until a query engine feature
    // is missing and the only fix is a schema migration.
    expect(config.schema_config.configs).toHaveLength(1);
    const schema = config.schema_config.configs[0];
    expect(schema.store).toBe("tsdb");
    expect(schema.schema).toBe("v13");
    expect(schema.object_store).toBe("filesystem");
    expect(yaml.stringify(config.schema_config)).not.toContain("boltdb");
  });

  test("retention is actually ENFORCED, not just applied to queries", async () => {
    const config = await lokiConfig();
    // `retention_period` on its own only hides old data from queries; without
    // an enabled compactor holding a delete_request_store, the chunks stay on
    // disk forever and the PVC fills up.
    expect(config.limits_config.retention_period).toBe("336h");
    expect(config.compactor.retention_enabled).toBe(true);
    expect(config.compactor.delete_request_store).toBe("filesystem");
    expect(config.compactor.working_directory).toMatch(/^\/loki\//);
    expect(config.limits_config.reject_old_samples).toBe(true);
  });

  test("single-binary: one replica, monolithic target, RF 1, Recreate", async () => {
    const config = await lokiConfig();
    expect(config.common.replication_factor).toBe(1);
    expect(config.common.path_prefix).toBe("/loki");

    const spec = await get<{
      replicas: number;
      strategy: { type: string };
      template: { spec: PodSpec };
    }>(installLoki().deployment, "spec");
    expect(spec.replicas).toBe(1);
    // A rolling update deadlocks on the RWO PVC.
    expect(spec.strategy.type).toBe("Recreate");
    expect(spec.template.spec.containers[0].args).toContain("-target=all");
  });

  test("fsGroup 10001 is set, or the image crash-loops on the local-path volume", async () => {
    const spec = await get<{ template: { spec: PodSpec } }>(installLoki().deployment, "spec");
    expect(spec.template.spec.securityContext?.fsGroup).toBe(10001);
  });

  test("no cpu limit on the Loki container", async () => {
    const spec = await get<{ template: { spec: PodSpec } }>(installLoki().deployment, "spec");
    expect(spec.template.spec.containers[0].resources?.limits?.cpu).toBeUndefined();
  });
});

describe("installAlloy (issue #216)", () => {
  test("promotes ONLY the low-cardinality label set", async () => {
    const config = await alloyConfig();

    // The labels stage is the only place a field becomes a stream dimension.
    // Match the inner `values = { ... }` map, not the enclosing block: the
    // outer capture starts with the literal `values =`, which a naive
    // key-matching regex would count as a promoted label.
    const stage = config.match(/stage\.labels\s*\{\s*values\s*=\s*\{([\s\S]*?)\}/);
    expect(stage).not.toBeNull();
    const promoted = [...(stage?.[1] ?? "").matchAll(/^\s*(\w+)\s*=/gm)].map((m) => m[1]);
    expect(promoted.sort()).toEqual(["level", "service"]);

    // …and the relabel stage contributes exactly the k8s identity labels.
    const targetLabels = [...config.matchAll(/target_label\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(targetLabels.sort()).toEqual(["app", "container", "namespace", "pod"]);

    // Unbounded fields must never appear as labels: one stream per request is
    // how a Loki install is destroyed unrecoverably.
    for (const forbidden of ["req_id", "reqId", "trace_id", "traceId", "user_id", "span_id"]) {
      expect(targetLabels).not.toContain(forbidden);
      expect(promoted).not.toContain(forbidden);
    }
  });

  test("parses pino JSON with the field names packages/logger actually emits", async () => {
    const config = await alloyConfig();
    expect(config).toContain("stage.json");
    for (const field of ["level", "msg", "service", "env", "time"]) {
      expect(config).toMatch(new RegExp(`${field}\\s*=\\s*"${field}"`));
    }
    // pino's `level` is numeric; promoting it raw yields {level="30"}.
    expect(config).toContain("stage.template");
  });

  test("writes to the in-cluster Loki service", async () => {
    expect(await alloyConfig()).toContain(
      "http://loki.observability.svc.cluster.local:3100/loki/api/v1/push",
    );
  });

  test("uses the API-based source: no hostPath, not privileged", async () => {
    const config = await alloyConfig();
    expect(config).toContain("loki.source.kubernetes");
    expect(config).not.toContain("loki.source.file");

    const spec = await get<{
      template: {
        spec: {
          volumes: { name: string; hostPath?: unknown }[];
          containers: {
            securityContext?: { privileged?: boolean };
            resources?: { limits?: Record<string, string> };
          }[];
          tolerations: { key: string; operator: string; effect: string }[];
        };
      };
    }>(installAlloy().daemonSet, "spec");
    expect(spec.template.spec.volumes.some((v) => v.hostPath !== undefined)).toBe(false);
    expect(spec.template.spec.containers[0].securityContext?.privileged).toBe(false);
    expect(spec.template.spec.containers[0].resources?.limits?.cpu).toBeUndefined();
    expect(spec.template.spec.tolerations).toContainEqual({
      key: "node-role.kubernetes.io/control-plane",
      operator: "Exists",
      effect: "NoSchedule",
    });
  });

  test("each DaemonSet pod only tails its own node", async () => {
    expect(await alloyConfig()).toContain('regex         = sys.env("NODE_NAME")');
    const spec = await get<{
      template: { spec: { containers: { env?: { name: string; valueFrom?: unknown }[] }[] } };
    }>(installAlloy().daemonSet, "spec");
    expect(spec.template.spec.containers[0].env?.find((e) => e.name === "NODE_NAME")).toEqual({
      name: "NODE_NAME",
      valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } },
    });
  });

  test("RBAC grants pods/log — the endpoint the API-based source reads", async () => {
    const rules = await get<{ resources: string[]; verbs: string[] }[]>(
      installAlloy().clusterRole,
      "rules",
    );
    expect(rules[0].resources).toEqual(
      expect.arrayContaining([
        "pods",
        "pods/log",
        "nodes",
        "nodes/proxy",
        "namespaces",
        "services",
        "endpoints",
      ]),
    );
    expect(rules[0].verbs.sort()).toEqual(["get", "list", "watch"]);
  });
});
