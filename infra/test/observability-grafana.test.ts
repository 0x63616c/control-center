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

let grafana: typeof import("../src/observability/grafana.ts");
let dashboards: typeof import("../src/observability/dashboards.ts");
beforeAll(async () => {
  grafana = await import("../src/observability/grafana.ts");
  dashboards = await import("../src/observability/dashboards.ts");
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

const provider = () => new k8s.Provider("grafana-test", { context: "x" });
const namespace = () =>
  new k8s.core.v1.Namespace("observability-grafana-test", {
    metadata: { name: "observability" },
  });

function install() {
  const provider_ = provider();
  const namespace_ = namespace();
  return grafana.installGrafana({
    provider: provider_,
    namespace: namespace_,
    dashboardConfigMaps: dashboards.installDashboardConfigMaps({
      provider: provider_,
      namespace: namespace_,
    }),
  });
}

interface ContainerSpec {
  image: string;
  env?: { name: string; value?: string }[];
}
interface DeploymentSpec {
  replicas: number;
  strategy?: { type: string };
  template: { spec: { containers: ContainerSpec[]; securityContext?: { fsGroup?: number } } };
}

const envValue = (container: ContainerSpec, name: string) =>
  container.env?.find((e) => e.name === name)?.value;

describe("installGrafana (issues #209, #210)", () => {
  test("datasource provisioning pins BOTH datasource UIDs, since dashboard JSON references them", async () => {
    const data = await get<Record<string, string>>(install().datasources, "data");
    const yaml = data["datasources.yaml"];
    expect(yaml).toContain("uid: www-prometheus");
    expect(yaml).toContain("uid: www-loki");
    expect(yaml).toContain("http://prometheus.observability.svc.cluster.local:9090");
    expect(yaml).toContain("http://loki.observability.svc.cluster.local:3100");
    expect(yaml).toContain("isDefault: true");
  });

  test("the dashboard provider forbids UI updates — checked-in JSON is the source of truth", async () => {
    const data = await get<Record<string, string>>(install().dashboardProvider, "data");
    const yaml = data["dashboards.yaml"];
    expect(yaml).toContain("allowUiUpdates: false");
    expect(yaml).not.toContain("allowUiUpdates: true");
    expect(yaml).toContain("path: /var/lib/grafana/dashboards");
  });

  test("auth-proxy trust is bounded by the pod CIDR and the login form is gone", async () => {
    const spec = await get<DeploymentSpec>(install().deployment, "spec");
    const container = spec.template.spec.containers[0];
    expect(envValue(container, "GF_AUTH_PROXY_ENABLED")).toBe("true");
    expect(envValue(container, "GF_AUTH_PROXY_HEADER_NAME")).toBe(
      "Cf-Access-Authenticated-User-Email",
    );
    // Without the whitelist, ANY caller able to reach the pod could set the
    // identity header and sign up as Admin.
    expect(envValue(container, "GF_AUTH_PROXY_WHITELIST")).toBe("10.244.0.0/16");
    expect(envValue(container, "GF_AUTH_DISABLE_LOGIN_FORM")).toBe("true");
    expect(envValue(container, "GF_AUTH_ANONYMOUS_ENABLED")).toBe("false");
  });

  test("Recreate strategy and fsGroup 472, or the RWO volume wedges/crash-loops", async () => {
    const spec = await get<DeploymentSpec>(install().deployment, "spec");
    expect(spec.strategy?.type).toBe("Recreate");
    expect(spec.template.spec.securityContext?.fsGroup).toBe(472);
  });

  test("the Service is ClusterIP — the Cloudflare tunnel is the only path in", async () => {
    const spec = await get<{ type: string; ports: { port: number }[] }>(install().service, "spec");
    expect(spec.type).toBe("ClusterIP");
    expect(spec.ports[0].port).toBe(3000);
  });
});
