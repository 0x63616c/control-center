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
let temporal: typeof import("../src/temporal.ts");
beforeAll(async () => {
  softwareFactory = await import("../src/software-factory.ts");
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

// NOT a vault key (#593): the caller (infra/program.ts) sources this from the
// world-wide-webb-cloudflare stack's `accessAppAuds` output via
// StackReference, not the vault. See SoftwareFactoryArgs.accessAud.
const accessAud = "mock-audience";

const digests = {
  "software-factory-worker": `sha256:${"a".repeat(64)}`,
  "software-factory-run-worker": `sha256:${"1".repeat(64)}`,
  "software-factory-relay": `sha256:${"c".repeat(64)}`,
  "software-factory-api": `sha256:${"d".repeat(64)}`,
  "software-factory-console": `sha256:${"e".repeat(64)}`,
  "software-factory-blobs": `sha256:${"f".repeat(64)}`,
  "software-factory-codec": `sha256:${"0".repeat(64)}`,
};

const namespace = new k8s.core.v1.Namespace("software-factory-test-namespace", {
  metadata: { name: "software-factory" },
});

const install = (
  imageDigests: Record<string, string> = {},
  requireImageDigestPins = false,
  accessAudOverride: pulumi.Input<string> = accessAud,
) =>
  softwareFactory.installSoftwareFactory({
    provider: new k8s.Provider("test", { context: "x" }),
    namespace,
    vault,
    accessAud: accessAudOverride,
    imageDigests,
    nasNfsServer: "192.168.0.218",
    requireImageDigestPins,
  });

interface PolicyRule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
  resourceNames?: string[];
}

async function rulesFor(resource: string): Promise<PolicyRule[]> {
  const rules = await get<PolicyRule[]>(install().role, "rules");
  return rules.filter((r) => r.resources.includes(resource));
}

// ruleFor is for a resource this Role grants exactly one rule for. "secrets"
// is granted by two — the pinned codex-auth rule and the unpinned per-ticket
// rule (#434) — and silently returning the first of them would make a test
// pass for the wrong rule instead of failing loudly. Use rulesFor and select
// by resourceNames for those.
async function ruleFor(resource: string): Promise<PolicyRule> {
  const rules = await rulesFor(resource);
  if (rules.length === 0) throw new Error(`no rule for ${resource}`);
  if (rules.length > 1) {
    throw new Error(
      `${rules.length} rules grant ${resource}; ruleFor cannot disambiguate between them — use rulesFor and select by resourceNames or verbs instead`,
    );
  }
  return rules[0];
}

interface Container {
  name: string;
  image: string;
  env: {
    name: string;
    value?: string;
    valueFrom?: { fieldRef?: { fieldPath?: string }; secretKeyRef?: { name: string; key: string } };
  }[];
  volumeMounts: { name: string; mountPath: string; subPath?: string }[];
  readinessProbe?: { httpGet?: { path: string; port: string } };
  livenessProbe?: { httpGet?: { path: string; port: string } };
  securityContext?: {
    allowPrivilegeEscalation?: boolean;
    capabilities?: { drop?: string[] };
  };
}
interface PodSpec {
  serviceAccountName?: string;
  automountServiceAccountToken?: boolean;
  securityContext?: { fsGroup?: number; runAsUser?: number; runAsGroup?: number };
  containers: Container[];
}
interface DeploymentSpec {
  replicas: number;
  strategy?: { type?: string };
  template: { spec: PodSpec };
}

async function deploymentSpec(imageDigests: Record<string, string> = {}): Promise<DeploymentSpec> {
  return get<DeploymentSpec>(install(imageDigests).worker, "spec");
}

describe("installSoftwareFactory namespace (ADR-0011, issue #325, talos-only)", () => {
  test("uses the shared 'software-factory' namespace", async () => {
    const meta = await get<{ name: string }>(install().namespace, "metadata");
    expect(meta.name).toBe("software-factory");
    expect(install().namespace).toBe(namespace);
    expect(softwareFactory.SOFTWARE_FACTORY_NAMESPACE).toBe("software-factory");
  });

  test("the k8s namespace and the Temporal namespace share one name", () => {
    // Two different kinds of namespace, deliberately named the same: one
    // vocabulary for "the software factory's isolation boundary". A drift here
    // would be silently confusing in logs, Grafana labels and workflow IDs.
    expect(softwareFactory.SOFTWARE_FACTORY_NAMESPACE).toBe(
      temporal.SOFTWARE_FACTORY_TEMPORAL_NAMESPACE,
    );
  });

  test("inherits the cluster-default baseline Pod Security, unlike home-assistant", async () => {
    // The sandbox that runs agent-authored code is a per-workload concern (it
    // gets its own hardening in podspec.go), NOT a reason to relax admission
    // for the whole namespace. Anything that needs `privileged` here should
    // have to argue for it explicitly, as homeassistant.ts does.
    const meta = await get<{ labels?: Record<string, string> }>(install().namespace, "metadata");
    expect(meta.labels?.["pod-security.kubernetes.io/enforce"]).toBeUndefined();
  });
});

describe("the worker's Role (#343)", () => {
  test("grants list on pods for target Run Worker maintenance", async () => {
    expect((await ruleFor("pods")).verbs).toContain("list");
  });

  test("grants EXACTLY create/delete/get/list on pods, and nothing else", async () => {
    // Exact equality, deliberately, and it must STAY exact. This is the only
    // thing keeping the verb set closed — replacing it with a toContain check
    // per verb would keep a green suite while letting a sixth verb land
    // unnoticed on the one rule in this file that cannot be scoped at all.
    expect([...(await ruleFor("pods")).verbs].sort()).toEqual(["create", "delete", "get", "list"]);
  });

  test("leaves the pods rule unscoped, because resourceNames cannot scope it", async () => {
    // Kubernetes silently IGNORES resourceNames for list/watch/create/
    // deletecollection. A clause here would read as a scoped grant while
    // behaving as a namespace-wide one — worse than an honest wide grant. The
    // namespace is the isolation boundary for pods, not this Role.
    expect((await ruleFor("pods")).resourceNames).toBeUndefined();
  });

  test("grants no pods/exec authority after legacy sandbox cutover", async () => {
    expect(await rulesFor("pods/exec")).toEqual([]);
  });

  test("pins the codex-auth secrets rule to that one credential, and to two verbs", async () => {
    // Scoping works here and not on pods, and the asymmetry is structural:
    // SecretClient binds namespace and name at construction, so no code path
    // could want `list`.
    const rules = await rulesFor("secrets");
    const rule = rules.find((r) => r.resourceNames !== undefined);
    if (!rule) throw new Error("no resourceNames-scoped secrets rule found");
    expect(rule.resourceNames).toEqual(["codex-auth"]);
    expect([...rule.verbs].sort()).toEqual(["get", "update"]);
  });

  test("grants target Run Worker Secret lifecycle without legacy exec authority", async () => {
    const rules = await rulesFor("secrets");
    const rule = rules.find((r) => r.resourceNames === undefined);
    if (!rule) throw new Error("no Run Worker secrets rule found");
    expect([...rule.verbs].sort()).toEqual(["create", "delete", "get", "list", "update"]);
  });

  test("grants nothing outside the core API group and no extra resource", async () => {
    const rules = await get<PolicyRule[]>(install().role, "rules");
    expect(rules.every((r) => r.apiGroups.every((g) => g === ""))).toBe(true);
    expect(rules.flatMap((r) => r.resources).sort()).toEqual(["pods", "secrets", "secrets"]);
  });
});

describe("the worker Deployment (#343)", () => {
  test("is a single replica with a Recreate strategy", async () => {
    // Two replicas would mean two credential refreshers, and a rolling update
    // over this volume is a deadlock this cluster has already hit.
    const spec = await deploymentSpec();
    expect(spec.replicas).toBe(1);
    expect(spec.strategy?.type).toBe("Recreate");
  });

  test("mounts its ServiceAccount token — the only workload here that does", async () => {
    const spec = (await deploymentSpec()).template.spec;
    expect(spec.serviceAccountName).toBe("software-factory-worker");
    expect(spec.automountServiceAccountToken).toBe(true);
  });

  test("reports ready only after target activation completes", async () => {
    const [container] = (await deploymentSpec()).template.spec.containers;
    expect(container.readinessProbe?.httpGet).toEqual({ path: "/readyz", port: "metrics" });
    expect(container.livenessProbe?.httpGet).toEqual({ path: "/healthz", port: "metrics" });
  });

  test("does not register the retired sandbox image", async () => {
    const [container] = (await deploymentSpec(digests)).template.spec.containers;
    expect(container.env.find((e) => e.name === "SANDBOX_IMAGE")).toBeUndefined();
    expect(container.image).toBe(
      `ghcr.io/0x63616c/software-factory-worker@${digests["software-factory-worker"]}`,
    );
  });

  test("hands the separately pinned target Run Worker image to the main worker", async () => {
    const [container] = (await deploymentSpec(digests)).template.spec.containers;
    const runWorker = container.env.find((e) => e.name === "RUN_WORKER_IMAGE");
    expect(runWorker?.value).toBe(
      `ghcr.io/0x63616c/software-factory-run-worker@${digests["software-factory-run-worker"]}`,
    );
    expect(container.env.find((e) => e.name === "CHECKPOINT_API_URL")?.value).toBe(
      "http://api.software-factory.svc.cluster.local:8080",
    );
  });

  test("hands the worker the pull secret name every Run Worker authenticates with", async () => {
    const [container] = (await deploymentSpec()).template.spec.containers;
    const pullSecret = container.env.find((e) => e.name === "RUN_WORKER_IMAGE_PULL_SECRET_NAME");
    expect(pullSecret?.value).toBe("ghcr-pull");
  });

  test("runs as the uid and gid its image declares", async () => {
    const ctx = (await deploymentSpec()).template.spec.securityContext;
    expect(ctx?.runAsUser).toBe(65532);
    expect(ctx?.runAsGroup).toBe(ctx?.runAsUser);
  });

  test("takes POD_NAME from the downward API, never a literal", async () => {
    // D1 uses POD_NAME as the codexauth lease holder. A literal would make
    // every restart claim the SAME identity, and the compare-and-swap lease is
    // the only thing preventing two refreshers from invalidating each other —
    // replicas:1 buys none of that. So this is a correctness bug, not config
    // tidiness, and presence alone (which the parity guard checks) is not
    // enough: it has to be a fieldRef.
    const [container] = (await deploymentSpec()).template.spec.containers;
    const pod = container.env.find((e) => e.name === "POD_NAME");
    expect(pod?.value).toBeUndefined();
    expect(pod?.valueFrom?.fieldRef?.fieldPath).toBe("metadata.name");
  });

  test("names the Temporal frontend var the way LoadWorker spells it", async () => {
    // LoadWorker requires all eleven and defaults none, so a misnamed variable
    // is not a degraded worker — it is a CrashLoopBackOff on first start.
    // TEMPORAL_ADDRESS was the original mistake and reads perfectly plausibly.
    const [container] = (await deploymentSpec()).template.spec.containers;
    const names = container.env.map((e) => e.name);
    expect(names).toContain("TEMPORAL_HOST_PORT");
    expect(names).not.toContain("TEMPORAL_ADDRESS");
  });

  test("enables full payload codec support on the worker", async () => {
    const [container] = (await deploymentSpec()).template.spec.containers;

    expect(container.env.find((env) => env.name === "PAYLOAD_CODEC_MODE")?.value).toBe("full");
  });

  test("binds the metrics and health server, which are one address", async () => {
    // METRICS_ADDR carries /metrics AND /healthz, so an absent value costs
    // observability and liveness together.
    const [container] = (await deploymentSpec()).template.spec.containers;
    expect(container.env.find((e) => e.name === "METRICS_ADDR")?.value).toBe(":9464");
  });

  test("wires the dispatcher's database URL through the worker Secret, not a plain env value", async () => {
    // config.LoadWorker's one required database input (#551): the dispatcher's
    // RecordDispatcherState activity writes through this connection. It rides
    // the worker Secret like GITHUB_APP_ID does, never a literal, because
    // Pulumi composed it from the vault password bridged into the CNPG auth
    // Secret (cnpg.ts's createAuthSecret) for this same database.
    const [container] = (await deploymentSpec()).template.spec.containers;
    const databaseURL = container.env.find((e) => e.name === "SOFTWARE_FACTORY_DATABASE_URL");
    expect(databaseURL?.value).toBeUndefined();
    expect(databaseURL?.valueFrom?.secretKeyRef?.name).toBe("software-factory-worker-secrets");
    expect(databaseURL?.valueFrom?.secretKeyRef?.key).toBe("DATABASE_URL");

    const stringData = await get<Record<string, string>>(install().workerSecret, "stringData");
    expect(stringData.DATABASE_URL).toBe(
      "postgres://postgres:mock-postgres-password@software-factory-postgres-rw:5432/software_factory",
    );
  });

  test("points the App private key env at the mounted FILE, not at a value", async () => {
    // The key is multi-line and base64-encoded in the vault; internal/config
    // reads it from a path.
    const [container] = (await deploymentSpec()).template.spec.containers;
    const keyFile = container.env.find((e) => e.name === "GITHUB_APP_PRIVATE_KEY_PEM_FILE");
    const mount = container.volumeMounts.find((m) => m.name === "app-private-key");
    expect(keyFile?.value).toBe(mount?.mountPath);
  });
});

describe("image digest pins (#342)", () => {
  test("refuses to render a mutable :main ref on a production cluster", () => {
    expect(() => install({}, true)).toThrow(/software-factory images; missing/);
  });

  test("asks only for ITS OWN pins, so control-center's absence is not an error", () => {
    // The reverse coupling is the one that matters and is asserted in
    // image-digests.test.ts: serviceSpecs must not demand software-factory's
    // pins, or a broken sandbox build blocks the house's deploy.
    expect(() => install(digests, true)).not.toThrow();
  });
});

describe("factory API and console workloads (#554)", () => {
  test("keep the API private behind a console Service and harden both pods", async () => {
    const resources = install(digests, true);
    const apiService = await get<{
      type: string;
      ports: { name: string; port: number; targetPort: number }[];
    }>(resources.apiService, "spec");
    const webService = await get<{
      type: string;
      ports: { name: string; port: number; targetPort: number }[];
    }>(resources.webService, "spec");
    const api = await get<DeploymentSpec>(resources.api, "spec");
    const web = await get<DeploymentSpec>(resources.web, "spec");

    expect(apiService.type).toBe("ClusterIP");
    expect(apiService.ports).toEqual([{ name: "http", port: 8080, targetPort: 8080 }]);
    expect(webService.type).toBe("ClusterIP");
    expect(webService.ports).toEqual([{ name: "http", port: 80, targetPort: 8080 }]);
    for (const spec of [api.template.spec, web.template.spec]) {
      expect(spec.serviceAccountName).toBeUndefined();
      expect(spec.automountServiceAccountToken).toBe(false);
      expect(spec.securityContext?.runAsUser).toBeDefined();
    }
    const [apiContainer] = api.template.spec.containers;
    for (const deployment of [api, web]) {
      const [container] = deployment.template.spec.containers;
      expect(container.securityContext?.allowPrivilegeEscalation).toBe(false);
      expect(container.securityContext?.capabilities?.drop).toEqual(["ALL"]);
    }
    expect(apiContainer.image).toBe(
      `ghcr.io/0x63616c/software-factory-api@${digests["software-factory-api"]}`,
    );
    expect(apiContainer.env.map((env) => env.name)).toEqual(
      expect.arrayContaining([
        "SOFTWARE_FACTORY_DATABASE_PASSWORD",
        "SOFTWARE_FACTORY_DATABASE_HOST",
        "SOFTWARE_FACTORY_DATABASE_NAME",
        "SOFTWARE_FACTORY_DATABASE_USER",
        "CLOUDFLARE_ACCESS_TEAM_DOMAIN",
        "CLOUDFLARE_ACCESS_AUD",
        "SOFTWARE_FACTORY_API__WORKER_BEARER_TOKEN",
        "SOFTWARE_FACTORY_API__RUN_WORKER_BEARER_TOKEN",
        "GITHUB_BOT_APP__WEBHOOK_SECRET",
        "TEMPORAL_HOST_PORT",
        "TEMPORAL_NAMESPACE",
      ]),
    );
    expect(apiContainer.readinessProbe?.httpGet).toEqual({ path: "/healthz", port: "http" });
    expect(
      apiContainer.env.find((env) => env.name === "SOFTWARE_FACTORY_DATABASE_PASSWORD")?.valueFrom
        ?.secretKeyRef,
    ).toEqual({ name: "software-factory-postgres-auth", key: "password" });
    expect(
      apiContainer.env.find((env) => env.name === "GITHUB_BOT_APP__WEBHOOK_SECRET")?.valueFrom
        ?.secretKeyRef,
    ).toEqual({ name: "software-factory-api-secrets", key: "GITHUB_BOT_APP__WEBHOOK_SECRET" });
    expect(
      apiContainer.env.find((env) => env.name === "SOFTWARE_FACTORY_API__RUN_WORKER_BEARER_TOKEN")
        ?.valueFrom?.secretKeyRef,
    ).toEqual({
      name: "software-factory-api-secrets",
      key: "SOFTWARE_FACTORY_API__RUN_WORKER_BEARER_TOKEN",
    });
    for (const deployment of [api, web]) {
      expect(
        deployment.template.spec.containers.flatMap((container) => container.volumeMounts ?? []),
      ).not.toContainEqual(expect.objectContaining({ name: "transcripts" }));
    }
  });
});

describe("Cloudflare Access AUD bootstrap (#593)", () => {
  test("wires the caller-supplied AUD through to the API Secret, not the vault", async () => {
    // The caller (infra/program.ts) sources this from the
    // world-wide-webb-cloudflare stack's `accessAppAuds` output via
    // StackReference — asserting the value flows straight through, unlike
    // CLOUDFLARE_ACCESS_TEAM_DOMAIN which is still `fromVault`.
    const stringData = await get<Record<string, string>>(install().apiSecret, "stringData");
    expect(stringData.CLOUDFLARE_ACCESS_AUD).toBe(accessAud);
    expect(stringData.CLOUDFLARE_ACCESS_TEAM_DOMAIN).toBe("example.cloudflareaccess.com");
  });

  test("an empty AUD (the app doesn't exist yet) does not throw or block the rest of the stack", () => {
    // Before world-wide-webb-cloudflare's deploy-cloudflare has ever created
    // factory.<zone>, the StackReference read in infra/program.ts resolves to
    // "" rather than throwing (see its `getOutput` vs `requireOutput` note).
    // installSoftwareFactory must accept that gracefully — a throw here would
    // abort the ENTIRE cluster's `pulumi up`, which is the whole-cluster
    // deadlock this AUD wiring exists to break.
    expect(() => install(digests, true, "")).not.toThrow();
  });

  test("marks the API Deployment skipAwait, so a still-missing AUD can't fail the apply", async () => {
    // cmd/api's config.LoadAPI (apps/software-factory/internal/config/api.go)
    // refuses to start on an empty CLOUDFLARE_ACCESS_AUD — correct fail-closed
    // behavior, but it means the pod CrashLoopBackOffs for as long as the AUD
    // is unresolved. Without skipAwait, Pulumi would wait for that Deployment
    // to become Ready and fail the whole `pulumi up` on timeout — reproducing
    // the exact deadlock from #593, just one resource over.
    const metadata = await get<{ annotations?: Record<string, string> }>(
      install(digests, true, "").api,
      "metadata",
    );
    expect(metadata.annotations?.["pulumi.com/skipAwait"]).toBe("true");
  });
});
