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
};

const digests = {
  "software-factory-worker": `sha256:${"a".repeat(64)}`,
  "software-factory-sandbox": `sha256:${"b".repeat(64)}`,
};

const install = (imageDigests: Record<string, string> = {}, requireImageDigestPins = false) =>
  softwareFactory.installSoftwareFactory({
    provider: new k8s.Provider("test", { context: "x" }),
    vault,
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

async function ruleFor(resource: string): Promise<PolicyRule> {
  const rules = await get<PolicyRule[]>(install().role, "rules");
  const rule = rules.find((r) => r.resources.includes(resource));
  if (!rule) throw new Error(`no rule for ${resource}`);
  return rule;
}

interface Container {
  name: string;
  image: string;
  env: { name: string; value?: string }[];
  volumeMounts: { name: string; mountPath: string; subPath?: string }[];
}
interface PodSpec {
  serviceAccountName?: string;
  automountServiceAccountToken?: boolean;
  securityContext?: { fsGroup?: number; runAsUser?: number };
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
  test("creates its own 'software-factory' namespace, outside InfraNamespaceName", async () => {
    const meta = await get<{ name: string }>(install().namespace, "metadata");
    expect(meta.name).toBe("software-factory");
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
  test("grants watch on pods, without which every sandbox start 403s", async () => {
    // WaitReady is watch-based (lifecycle.go). This verb was missing from the
    // ADR's first draft, and its absence would not have been subtle: the first
    // ticket ever worked would have failed to start a pod.
    expect((await ruleFor("pods")).verbs).toContain("watch");
  });

  test("does not grant list on pods", async () => {
    // The authorizer maps `GET .../pods?watch=true` to `watch`, not `list`, and
    // nothing calls Pods().List. Harmless to grant, but a verb nothing needs is
    // a verb nobody can later justify.
    expect((await ruleFor("pods")).verbs).not.toContain("list");
  });

  test("grants exactly create/get/watch/delete on pods", async () => {
    expect([...(await ruleFor("pods")).verbs].sort()).toEqual(["create", "delete", "get", "watch"]);
  });

  test("leaves the pods rule unscoped, because resourceNames cannot scope it", async () => {
    // Kubernetes silently IGNORES resourceNames for list/watch/create/
    // deletecollection. A clause here would read as a scoped grant while
    // behaving as a namespace-wide one — worse than an honest wide grant. The
    // namespace is the isolation boundary for pods, not this Role.
    expect((await ruleFor("pods")).resourceNames).toBeUndefined();
  });

  test("grants get as well as create on pods/exec", async () => {
    // The WebSocket executor issues a GET (exec.go); only the deprecated SPDY
    // fallback uses POST. With `create` alone every exec either silently takes
    // the deprecated path or fails outright.
    expect([...(await ruleFor("pods/exec")).verbs].sort()).toEqual(["create", "get"]);
  });

  test("pins the secrets rule to the one credential Secret, and to two verbs", async () => {
    // Scoping works here and not on pods, and the asymmetry is structural:
    // SecretClient binds namespace and name at construction, so no code path
    // could want `list`.
    const rule = await ruleFor("secrets");
    expect(rule.resourceNames).toEqual(["codex-auth"]);
    expect([...rule.verbs].sort()).toEqual(["get", "update"]);
  });

  test("grants nothing outside the core API group, and no fourth resource", async () => {
    const rules = await get<PolicyRule[]>(install().role, "rules");
    expect(rules.every((r) => r.apiGroups.every((g) => g === ""))).toBe(true);
    expect(rules.flatMap((r) => r.resources).sort()).toEqual(["pods", "pods/exec", "secrets"]);
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

  test("hands the sandbox image to the worker as a digest-pinned env var", async () => {
    // The sandbox is never a workload here: the worker creates those pods
    // itself. Passing the pinned ref is what makes a sandbox as reproducible as
    // the worker that created it.
    const [container] = (await deploymentSpec(digests)).template.spec.containers;
    const sandbox = container.env.find((e) => e.name === "SANDBOX_IMAGE");
    expect(sandbox?.value).toBe(
      `ghcr.io/0x63616c/www-software-factory-sandbox@${digests["software-factory-sandbox"]}`,
    );
    expect(container.image).toBe(
      `ghcr.io/0x63616c/www-software-factory-worker@${digests["software-factory-worker"]}`,
    );
  });

  test("mounts transcripts on the worker, under its own directory in the export", async () => {
    const [container] = (await deploymentSpec()).template.spec.containers;
    const transcripts = container.volumeMounts.find((m) => m.name === "transcripts");
    expect(transcripts?.mountPath).toBe("/transcripts");
    expect(transcripts?.subPath).toBe("software-factory/transcripts");
  });

  test("runs as the uid its image declares, and shares it with the volume's fsGroup", async () => {
    // A mismatch here is the root_squash failure mode: every transcript Open
    // returns EACCES, and only against a real NFS export.
    const ctx = (await deploymentSpec()).template.spec.securityContext;
    expect(ctx?.runAsUser).toBe(65532);
    expect(ctx?.fsGroup).toBe(ctx?.runAsUser);
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

describe("the transcript volume (#343, from B4)", () => {
  test("is a soft mount with a bounded timeout", async () => {
    // A hard mount turns an unreachable NAS into a worker wedged in
    // uninterruptible sleep inside its own constructor, with nothing to log and
    // no heartbeat to fail.
    const spec = await get<{ mountOptions: string[] }>(install().transcriptsVolume, "spec");
    expect(spec.mountOptions).toContain("soft");
    expect(spec.mountOptions).toContain("timeo=100");
    expect(spec.mountOptions).toContain("retrans=3");
  });

  test("is ReadWriteMany on both the volume and the claim", async () => {
    const pv = await get<{ accessModes: string[] }>(install().transcriptsVolume, "spec");
    const pvc = await get<{ accessModes: string[] }>(install().transcriptsClaim, "spec");
    expect(pv.accessModes).toEqual(["ReadWriteMany"]);
    expect(pvc.accessModes).toEqual(["ReadWriteMany"]);
  });

  test("carries its capacity in its name, so a resize arrives as a new pair", async () => {
    // A bound static PVC cannot be resized in place.
    const meta = await get<{ name: string }>(install().transcriptsVolume, "metadata");
    const spec = await get<{ capacity: Record<string, string> }>(
      install().transcriptsVolume,
      "spec",
    );
    expect(meta.name).toContain(spec.capacity.storage.toLowerCase());
  });
});
