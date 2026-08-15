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

let esoModule: typeof import("../src/eso.ts");
let map: typeof import("../src/secrets-map.ts");
beforeAll(async () => {
  esoModule = await import("../src/eso.ts");
  map = await import("../src/secrets-map.ts");
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

const testNamespaces = {
  "control-center": "control-center",
  "dont-text-your-ex": "dont-text-your-ex",
  "software-factory": "software-factory",
  cloudflare: "cloudflare",
} as const;

describe("SERVICE_SECRETS", () => {
  test("worker mirrors api exactly (lockstep, www-51hf.35)", () => {
    const api = Object.keys(map.SERVICE_SECRETS.api).sort();
    const worker = Object.keys(map.SERVICE_SECRETS.worker).sort();
    expect(worker).toEqual(api);
    for (const [k, v] of Object.entries(map.SERVICE_SECRETS.api)) {
      expect(map.SERVICE_SECRETS.worker[k]).toBe(v);
    }
  });

  test("services with no secrets are absent (web/storybook/captive-portal)", () => {
    expect("web" in map.SERVICE_SECRETS).toBe(false);
    expect("storybook" in map.SERVICE_SECRETS).toBe(false);
    expect("captive-portal" in map.SERVICE_SECRETS).toBe(false);
    // captive-portal-api's workload was deleted (Task 4 step C, SDD track 0);
    // its Secret is gone too.
    expect("captive-portal-api" in map.SERVICE_SECRETS).toBe(false);
  });

  test("every ref is a VAULT_KEY (SCREAMING_SNAKE_CASE, no Item/field slash form)", () => {
    for (const secrets of Object.values(map.SERVICE_SECRETS)) {
      for (const ref of Object.values(secrets)) {
        // Flat SCREAMING_SNAKE vault key: no slash (vault.ts does a flat
        // lookup; ITEM__FIELD double-underscore is convention, not contract ,
        // the WIFI_GUEST_WIFI_* keys are single-underscore by choice).
        expect(ref).not.toMatch(/\//);
        expect(ref).toMatch(/^[A-Z0-9_]+$/);
      }
    }
  });
});

describe("installEso (native Secrets, CC-k8t7)", () => {
  test("emits one native Secret per service entry", async () => {
    const provider = new (await import("@pulumi/kubernetes")).Provider("test", { context: "x" });
    const mockVault: Record<string, string> = {};
    // populate all vault keys referenced by SERVICE_SECRETS
    for (const secrets of Object.values(map.SERVICE_SECRETS)) {
      for (const vaultKey of Object.values(secrets)) {
        mockVault[vaultKey] = `mock-${vaultKey}`;
      }
    }

    const res = esoModule.installEso({
      provider,
      namespaces: testNamespaces,
      vault: mockVault,
    });
    expect(res.externalSecrets).toHaveLength(Object.keys(map.SERVICE_SECRETS).length);
  });

  test("api Secret has expected env keys in stringData", async () => {
    const provider = new (await import("@pulumi/kubernetes")).Provider("test2", { context: "x" });
    const mockVault: Record<string, string> = {};
    for (const secrets of Object.values(map.SERVICE_SECRETS)) {
      for (const vaultKey of Object.values(secrets)) {
        mockVault[vaultKey] = `mock-${vaultKey}`;
      }
    }

    const res = esoModule.installEso({
      provider,
      namespaces: testNamespaces,
      vault: mockVault,
    });
    const apiSecret = res.externalSecrets[0];
    const stringData = await get<Record<string, string>>(apiSecret, "stringData");
    expect(Object.keys(stringData)).toContain("HA_TOKEN");
    expect(Object.keys(stringData)).toContain("WIFI_PASSWORD");
  });

  test("routes service Secrets to their owner namespaces", async () => {
    const provider = new (await import("@pulumi/kubernetes")).Provider("test4", { context: "x" });
    const mockVault: Record<string, string> = {};
    for (const secrets of Object.values(map.SERVICE_SECRETS)) {
      for (const vaultKey of Object.values(secrets)) {
        mockVault[vaultKey] = `mock-${vaultKey}`;
      }
    }

    const res = esoModule.installEso({ provider, namespaces: testNamespaces, vault: mockVault });
    const metadata = await Promise.all(
      res.externalSecrets.map((s) => get<{ name: string; namespace: string }>(s, "metadata")),
    );

    expect(metadata.find((m) => m.name === "control-center-secrets-api")?.namespace).toBe(
      "control-center",
    );
    expect(metadata.find((m) => m.name === "cloudflare-secrets-cloudflared")?.namespace).toBe(
      "cloudflare",
    );
  });
});
