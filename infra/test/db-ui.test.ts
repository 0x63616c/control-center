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

let dbUi: typeof import("../src/db-ui.ts");
beforeAll(async () => {
  dbUi = await import("../src/db-ui.ts");
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

const mockVault: Record<string, string> = {
  CONTROL_CENTER_POSTGRES__PASSWORD: "mock-cc-pw",
  HOME_ASSISTANT_POSTGRES__PASSWORD: "mock-ha-pw",
  TEMPORAL_POSTGRES__PASSWORD: "mock-temporal-pw",
  PGADMIN__PASSWORD: "mock-pgadmin-pw",
};

function install(vault: Record<string, string> = mockVault) {
  return dbUi.installDbUi({ provider: provider(), vault });
}

describe("installDbUi (issue #65, talos-only)", () => {
  test("creates its own 'db-ui' namespace", async () => {
    const res = install();
    const meta = await get<{ name: string }>(res.namespace, "metadata");
    expect(meta.name).toBe("db-ui");
  });

  test("servers.json declares all 3 clusters plus the temporal-visibility tree entry", async () => {
    const res = install();
    const data = await get<{ "servers.json": string }>(res.serversConfigMap, "data");
    const parsed = JSON.parse(data["servers.json"]) as {
      Servers: Record<string, { Name: string; Host: string; MaintenanceDB: string }>;
    };
    const names = Object.values(parsed.Servers).map((s) => s.Name);
    expect(names).toEqual(
      expect.arrayContaining([
        "control-center",
        "home-assistant",
        "temporal",
        "temporal-visibility",
      ]),
    );
    const cc = Object.values(parsed.Servers).find((s) => s.Name === "control-center");
    expect(cc?.Host).toBe("control-center-rw.control-center.svc.cluster.local");
    expect(cc?.MaintenanceDB).toBe("control_center");
    const visibility = Object.values(parsed.Servers).find((s) => s.Name === "temporal-visibility");
    expect(visibility?.MaintenanceDB).toBe("temporal_visibility");
  });

  test("no vault password value ever appears in servers.json (only PassFile paths)", async () => {
    const res = install();
    const data = await get<{ "servers.json": string }>(res.serversConfigMap, "data");
    for (const value of Object.values(mockVault)) {
      expect(data["servers.json"]).not.toContain(value);
    }
  });

  test("the pgpass Secret has one line per cluster, `*`-wildcarded on database", async () => {
    const res = install();
    const stringData = await get<{ pgpass: string }>(res.pgpassSecret, "stringData");
    const lines = stringData.pgpass.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines).toContain(
      "control-center-rw.control-center.svc.cluster.local:5432:*:postgres:mock-cc-pw",
    );
    expect(lines).toContain(
      "home-assistant-postgres-rw.home-assistant.svc.cluster.local:5432:*:postgres:mock-ha-pw",
    );
    expect(lines).toContain(
      "temporal-postgres-rw.temporal.svc.cluster.local:5432:*:postgres:mock-temporal-pw",
    );
  });

  test("pgAdmin's own login Secret carries the vault-sourced master password, not a literal default", async () => {
    const res = install();
    const stringData = await get<{ email: string; password: string }>(
      res.loginSecret,
      "stringData",
    );
    expect(stringData.password).toBe("mock-pgadmin-pw");
  });

  test.each([
    "CONTROL_CENTER_POSTGRES__PASSWORD",
    "HOME_ASSISTANT_POSTGRES__PASSWORD",
    "TEMPORAL_POSTGRES__PASSWORD",
    "PGADMIN__PASSWORD",
  ])("throws when the vault is missing %s", (missingKey) => {
    const vault = { ...mockVault };
    delete vault[missingKey];
    expect(() => install(vault)).toThrow(new RegExp(missingKey));
  });
});
