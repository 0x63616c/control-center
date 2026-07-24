import { describe, expect, test } from "vitest";
import type { WorkloadSpec } from "../src/component.ts";
import { renderExternalService, renderWorkload } from "../src/component.ts";
import { serviceSpecs } from "../src/services.ts";

// The mapping layer is pure: a WorkloadSpec -> the kubernetes resource ARG
// objects (Deployment + Services), with no Pulumi instantiation. This is the
// unit-testable core of the ComponentResource vocabulary (the thin Pulumi
// wrapper in component.ts just feeds these args to @pulumi/kubernetes).

const api: WorkloadSpec = {
  name: "api",
  image: "ghcr.io/0x63616c/www-control-center-api:main",
  replicas: 1,
  resources: { memory: "512M", reserveCpus: "0.5" },
  secrets: [{ name: "POSTGRES_PASSWORD", ref: "test-secret-ref" }],
  env: { NODE_ENV: "production", TZ: "America/Los_Angeles" },
  ports: [{ containerPort: 4201, expose: "cluster" }],
};

describe("renderWorkload", () => {
  test("maps the www-ke9a memory cap to limits.memory and a smaller requests.memory", () => {
    const r = renderWorkload(api);
    const container = r.deployment.spec.template.spec.containers[0];
    expect(container.resources.limits.memory).toBe("512M");
    // requests.memory must be set (scheduling floor) and not exceed the limit.
    expect(container.resources.requests.memory).toBeDefined();
    expect(container.resources.requests.memory).not.toBe("512M");
  });

  test("maps reserveCpus to requests.cpu", () => {
    const r = renderWorkload(api);
    const container = r.deployment.spec.template.spec.containers[0];
    expect(container.resources.requests.cpu).toBe("0.5");
  });

  test("mounts each secret as a file under /run/secrets/<NAME> from one ExternalSecret-backed Secret", () => {
    const r = renderWorkload(api);
    const container = r.deployment.spec.template.spec.containers[0];
    const mount = container.volumeMounts.find((m) => m.mountPath === "/run/secrets");
    expect(mount).toBeDefined();
    expect(mount?.readOnly).toBe(true);
    // The secret rides a projected/secret volume, not env, so values never land
    // in the pod spec.
    const vol = r.deployment.spec.template.spec.volumes.find((v) => v.name === mount?.name);
    expect(vol?.secret?.secretName).toBe("api-secrets");
  });

  test("plain env is passed through as env vars (no secret values)", () => {
    const r = renderWorkload(api);
    const container = r.deployment.spec.template.spec.containers[0];
    const names = container.env.map((e: { name: string }) => e.name);
    expect(names).toContain("NODE_ENV");
    expect(names).toContain("TZ");
    // A secret name must NOT appear as a plain env var (it's a file mount).
    expect(names).not.toContain("POSTGRES_PASSWORD");
  });

  test("expose:cluster yields a ClusterIP Service on the container port", () => {
    const r = renderWorkload(api);
    expect(r.services).toHaveLength(1);
    expect(r.services[0].spec.type).toBe("ClusterIP");
    expect(r.services[0].spec.ports[0].port).toBe(4201);
  });

  test("expose:lan yields a LoadBalancer Service (OrbStack LAN expose, §5a)", () => {
    const portal: WorkloadSpec = {
      name: "captive-portal",
      image: "ghcr.io/0x63616c/www-captive-portal-portal:main",
      replicas: 1,
      ports: [
        { containerPort: 443, expose: "lan" },
        { containerPort: 80, expose: "lan" },
      ],
    };
    const r = renderWorkload(portal);
    expect(r.services).toHaveLength(1);
    expect(r.services[0].spec.type).toBe("LoadBalancer");
    const ports = r.services[0].spec.ports
      .map((p: { port: number }) => p.port)
      .sort((a, b) => a - b);
    expect(ports).toEqual([80, 443]);
  });

  test("expose:none yields no Service", () => {
    const worker: WorkloadSpec = {
      name: "worker",
      image: "ghcr.io/0x63616c/www-control-center-worker:main",
      replicas: 1,
    };
    expect(renderWorkload(worker).services).toHaveLength(0);
  });

  test("an NFS volume emits mountOptions [nfsvers=3, nolock, tcp] (DS420+ is NFSv3-only, §5b)", () => {
    const media: WorkloadSpec = {
      name: "worker",
      image: "ghcr.io/0x63616c/www-control-center-worker:main",
      replicas: 1,
      volumes: [
        {
          mountPath: "/app/media",
          nfs: { server: "192.168.0.218", path: "/volume1/Homelab/media" },
        },
      ],
    };
    const r = renderWorkload(media);
    expect(r.persistentVolumes).toHaveLength(1);
    const pv = r.persistentVolumes[0];
    expect(pv.spec.mountOptions).toEqual(["nfsvers=3", "nolock", "tcp"]);
    expect(pv.spec.nfs.server).toBe("192.168.0.218");
    expect(pv.spec.nfs.path).toBe("/volume1/Homelab/media");
  });

  test("replicas are honored (cloudflared HA = 2)", () => {
    const cf: WorkloadSpec = {
      name: "cloudflared",
      image: "cloudflare/cloudflared:2025.10.1",
      replicas: 2,
    };
    expect(renderWorkload(cf).deployment.spec.replicas).toBe(2);
  });
});

describe("renderWorkload: www-j934.6 extensions", () => {
  test("secretName has a neutral fallback and product-derived overrides are honored", () => {
    const def = renderWorkload(api).deployment.spec.template.spec.volumes.find(
      (v) => v.name === "secrets",
    );
    expect(def?.secret?.secretName).toBe("api-secrets");
    const over = renderWorkload({ ...api, secretName: "control-center-secrets-api" });
    const vol = over.deployment.spec.template.spec.volumes.find((v) => v.name === "secrets");
    expect(vol?.secret?.secretName).toBe("control-center-secrets-api");
  });

  test("imagePullSecrets land on the pod spec", () => {
    const r = renderWorkload({ ...api, imagePullSecrets: ["ghcr-pull"] });
    expect(r.deployment.spec.template.spec.imagePullSecrets).toEqual([{ name: "ghcr-pull" }]);
  });

  test("no imagePullSecrets field when none declared", () => {
    const r = renderWorkload(api);
    expect(r.deployment.spec.template.spec.imagePullSecrets).toBeUndefined();
  });

  test("extraSecretMounts mount a secret as files at their own path (portal TLS)", () => {
    const portal: WorkloadSpec = {
      name: "captive-portal",
      image: "ghcr.io/0x63616c/www-captive-portal-portal:main",
      replicas: 1,
      resources: { memory: "64M" },
      extraSecretMounts: [{ secretName: "captive-portal-tls", mountPath: "/etc/tls" }],
      ports: [{ containerPort: 443, expose: "lan" }],
    };
    const r = renderWorkload(portal);
    const mount = r.deployment.spec.template.spec.containers[0].volumeMounts.find(
      (m) => m.mountPath === "/etc/tls",
    );
    expect(mount).toBeDefined();
    expect(mount?.readOnly).toBe(true);
    const vol = r.deployment.spec.template.spec.volumes.find((v) => v.name === mount?.name);
    expect(vol?.secret?.secretName).toBe("captive-portal-tls");
  });

  test("extraSecretMounts items rename keys to file paths (cert-manager tls.crt -> fullchain.pem)", () => {
    const portal: WorkloadSpec = {
      name: "captive-portal",
      image: "ghcr.io/0x63616c/www-captive-portal-portal:main",
      replicas: 1,
      resources: { memory: "64M" },
      extraSecretMounts: [
        {
          secretName: "captive-portal-tls",
          mountPath: "/certs",
          items: [
            { key: "tls.crt", path: "fullchain.pem" },
            { key: "tls.key", path: "key.pem" },
          ],
        },
      ],
      ports: [{ containerPort: 443, expose: "lan" }],
    };
    const r = renderWorkload(portal);
    const mount = r.deployment.spec.template.spec.containers[0].volumeMounts.find(
      (m) => m.mountPath === "/certs",
    );
    const vol = r.deployment.spec.template.spec.volumes.find((v) => v.name === mount?.name);
    expect(vol?.secret?.items).toEqual([
      { key: "tls.crt", path: "fullchain.pem" },
      { key: "tls.key", path: "key.pem" },
    ]);
  });
});

describe("renderWorkload: NFS PV + PVC pair (www-j934.6)", () => {
  test("an NFS volume emits a statically-bound PVC alongside the PV", () => {
    const mw: WorkloadSpec = {
      name: "worker",
      image: "ghcr.io/0x63616c/www-control-center-worker:main",
      replicas: 1,
      resources: { memory: "512M" },
      volumes: [
        {
          mountPath: "/app/media",
          nfs: { server: "192.168.0.218", path: "/volume1/Homelab/media" },
        },
      ],
    };
    const r = renderWorkload(mw);
    expect(r.persistentVolumes).toHaveLength(1);
    expect(r.persistentVolumeClaims).toHaveLength(1);
    // PVC binds to the PV by name, storageClassName "" (no dynamic provisioner).
    const pvc = r.persistentVolumeClaims[0];
    expect(pvc.spec.volumeName).toBe(r.persistentVolumes[0].metadata.name);
    expect(pvc.spec.storageClassName).toBe("");
    expect(r.persistentVolumes[0].spec.storageClassName).toBe("");
    // The pod mounts the PVC of the same name.
    const vol = r.deployment.spec.template.spec.volumes.find((v) => v.persistentVolumeClaim);
    expect(vol?.persistentVolumeClaim?.claimName).toBe(pvc.metadata.name);
  });
});

describe("renderExternalService (ExternalName CNAME to an off-cluster host)", () => {
  test("emits an ExternalName Service aliasing the in-cluster name to the external FQDN", () => {
    const r = renderExternalService("ha", "homelab.tail8c014d.ts.net");
    expect(r.service.spec.type).toBe("ExternalName");
    expect(r.service.spec.externalName).toBe("homelab.tail8c014d.ts.net");
    expect(r.service.metadata.name).toBe("ha");
  });
});

describe("serviceSpecs (replica + NFS knobs, www-j934.17 / www-j934.18)", () => {
  const baseOpts = {
    cloudflaredReplicas: 2,
    nasNfsServer: "192.168.0.218",
  };
  const specOf = (specs: WorkloadSpec[], name: string) => specs.find((s) => s.name === name);

  test("drizzle is no longer a declared workload (Drizzle Gateway torn down)", () => {
    expect(specOf(serviceSpecs(baseOpts), "drizzle")).toBeUndefined();
  });

  test("threads nasNfsServer into the worker NFS volume", () => {
    const specs = serviceSpecs({ ...baseOpts, nasNfsServer: "100.78.116.99" });
    const vol = specOf(specs, "worker")?.volumes?.[0];
    expect(vol?.nfs?.server).toBe("100.78.116.99");
    expect(vol?.nfs?.path).toBe("/volume1/Homelab");
    expect(vol?.subPath).toBe("media");
  });

  test("worker absorbed the media workload: NFS media mount, MEDIA_STORAGE_DIR, 512M", () => {
    const worker = specOf(serviceSpecs(baseOpts), "worker");
    expect(worker?.resources?.memory).toBe("512M");
    expect(worker?.env?.MEDIA_STORAGE_DIR).toBe("/app/media");
    expect(worker?.volumes?.[0]?.mountPath).toBe("/app/media");
  });

  test("media-worker is no longer a declared workload", () => {
    expect(specOf(serviceSpecs(baseOpts), "media-worker")).toBeUndefined();
  });

  test("captive-portal-portal/captive-portal-api are no longer declared workloads (Task 4 step C, SDD track 0)", () => {
    const logicalNames = serviceSpecs(baseOpts).map((spec) => spec.logicalName);
    expect(logicalNames).not.toContain("captive-portal-portal");
    expect(logicalNames).not.toContain("captive-portal-api");
  });

  test("cloudflared replicas come from the cloudflaredReplicas knob (0 pre-cutover, 2 HA)", () => {
    expect(
      specOf(serviceSpecs({ ...baseOpts, cloudflaredReplicas: 0 }), "cloudflared")?.replicas,
    ).toBe(0);
    expect(
      specOf(serviceSpecs({ ...baseOpts, cloudflaredReplicas: 2 }), "cloudflared")?.replicas,
    ).toBe(2);
  });

  test("assigns product workloads to owner namespaces with namespace-local names", () => {
    const specs = serviceSpecs(baseOpts).map((spec) => ({
      logicalName: spec.logicalName,
      name: spec.name,
      namespaceName: spec.namespaceName,
      secretName: spec.secretName,
    }));

    expect(specs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logicalName: "control-center-api",
          name: "api",
          namespaceName: "control-center",
          secretName: "control-center-secrets-api",
        }),
        expect.objectContaining({
          logicalName: "control-center-web",
          name: "web",
          namespaceName: "control-center",
        }),
        expect.objectContaining({
          logicalName: "control-center-worker",
          name: "worker",
          namespaceName: "control-center",
        }),
        expect.objectContaining({
          logicalName: "platform-cloudflared",
          name: "cloudflared",
          namespaceName: "platform",
          secretName: "platform-secrets-cloudflared",
        }),
      ]),
    );
  });

  test("derives POSTGRES_HOST from product database manifests", () => {
    const specs = serviceSpecs(baseOpts);
    const controlCenterApi = specs.find((spec) => spec.logicalName === "control-center-api");

    expect(controlCenterApi?.env?.POSTGRES_HOST).toBe("control-center-rw");
  });
});

// www-hn1i: initContainers, first user is the web map-provision init, which
// makes "the basemap exists in the maps PVC" a structural precondition of
// nginx serving (a fresh stack self-provisions; nothing manual to remember).
describe("renderWorkload: initContainers (www-hn1i)", () => {
  const webWithInit: WorkloadSpec = {
    name: "web",
    image: "ghcr.io/0x63616c/www-control-center-web:main",
    replicas: 1,
    ports: [{ containerPort: 80, expose: "cluster" }],
    volumes: [{ mountPath: "/usr/share/nginx/html/maps", claim: "maps", readOnly: true }],
    initContainers: [
      {
        name: "map-provision",
        image: "ghcr.io/0x63616c/www-control-center-map-provision:main",
        command: ["/provision.sh"],
        volumes: [{ mountPath: "/out", claim: "maps" }],
      },
    ],
  };

  test("renders initContainers into the pod template ahead of the main container", () => {
    const r = renderWorkload(webWithInit);
    const init = r.deployment.spec.template.spec.initContainers?.[0];
    expect(init?.name).toBe("map-provision");
    expect(init?.image).toBe("ghcr.io/0x63616c/www-control-center-map-provision:main");
    expect(init?.command).toEqual(["/provision.sh"]);
  });

  test("the init container mounts its claim RW while the main container stays RO", () => {
    const r = renderWorkload(webWithInit);
    const init = r.deployment.spec.template.spec.initContainers?.[0];
    const initMount = init?.volumeMounts.find((m) => m.mountPath === "/out");
    expect(initMount).toBeDefined();
    expect(initMount?.readOnly).not.toBe(true);
    const main = r.deployment.spec.template.spec.containers[0];
    const mainMount = main.volumeMounts.find((m) => m.mountPath.endsWith("/maps"));
    expect(mainMount?.readOnly).toBe(true);
  });

  test("init volumes reuse the main pod volume when they mount the same claim", () => {
    const r = renderWorkload(webWithInit);
    const volumes = r.deployment.spec.template.spec.volumes.filter(
      (v) => v.persistentVolumeClaim?.claimName === "maps",
    );
    expect(volumes).toEqual([{ name: "vol-0", persistentVolumeClaim: { claimName: "maps" } }]);

    const init = r.deployment.spec.template.spec.initContainers?.[0];
    const initMount = init?.volumeMounts.find((m) => m.mountPath === "/out");
    const main = r.deployment.spec.template.spec.containers[0];
    const mainMount = main.volumeMounts.find((m) => m.mountPath.endsWith("/maps"));
    expect(initMount?.name).toBe("vol-0");
    expect(mainMount?.name).toBe("vol-0");
  });

  test("a workload without initContainers renders none (field absent, not [])", () => {
    const r = renderWorkload(api);
    expect(r.deployment.spec.template.spec.initContainers).toBeUndefined();
  });
});

// www-hn1i: the production web spec ships the map-provision init container so a
// fresh stack serves the Tesla basemap with ZERO manual steps.
describe("serviceSpecs: web map-provision initContainer (www-hn1i)", () => {
  const baseOpts = {
    cloudflaredReplicas: 2,
    nasNfsServer: "192.168.0.218",
  };
  const web = () => serviceSpecs(baseOpts).find((s) => s.name === "web");

  test("web declares the map-provision initContainer in if-missing mode", () => {
    const init = web()?.initContainers?.[0];
    expect(init?.name).toBe("map-provision");
    expect(init?.image).toContain("www-control-center-map-provision");
    // Default (no `force` arg) is if-missing: instant no-op when the file exists,
    // so rollouts on a provisioned PVC are unaffected.
    expect(init?.command).toEqual(["/provision.sh"]);
    expect(init?.volumes?.[0]?.claim).toBe("maps");
  });

  test("the init image is digest-pinnable like every other CI-built image", () => {
    const specs = serviceSpecs({
      ...baseOpts,
      imageDigests: { "control-center-map-provision": `sha256:${"a".repeat(64)}` },
    });
    const init = specs.find((s) => s.name === "web")?.initContainers?.[0];
    expect(init?.image).toBe(
      `ghcr.io/0x63616c/www-control-center-map-provision@sha256:${"a".repeat(64)}`,
    );
  });
});

// Task 4 (Talos migration): Plex's GPU/RuntimeClass wiring is talos-only. The
// load-bearing safety property , an untouched ("orbstack") apply renders
// Plex's spec BYTE-IDENTICAL to before this task , is asserted directly here.
describe("serviceSpecs: Plex GPU transcode is talos-only (Task 4)", () => {
  const baseOpts = {
    cloudflaredReplicas: 2,
    nasNfsServer: "192.168.0.218",
  };
  const plexOf = (opts: Parameters<typeof serviceSpecs>[0]) =>
    serviceSpecs(opts).find((s) => s.name === "plex");

  test("orbstack (default, no target passed): no gpu limit, no runtimeClassName", () => {
    const plex = plexOf(baseOpts);
    expect(plex?.resources?.gpu).toBeUndefined();
    expect(plex?.runtimeClassName).toBeUndefined();
  });

  test("orbstack (explicit target): identical to the default", () => {
    const plex = plexOf({ ...baseOpts, target: { substrate: "orbstack" } });
    expect(plex?.resources?.gpu).toBeUndefined();
    expect(plex?.runtimeClassName).toBeUndefined();
  });

  test("talos: gpu:1 limit + the nvidia RuntimeClass", () => {
    const plex = plexOf({
      ...baseOpts,
      target: { substrate: "talos", nodeIp: "192.168.0.5" },
    });
    expect(plex?.resources?.gpu).toBe(1);
    expect(plex?.runtimeClassName).toBe("nvidia");
  });

  test("talos ADVERTISE_IP uses the node LAN IP + MetalLB port, not the mini's frozen IP", () => {
    const plex = plexOf({
      ...baseOpts,
      target: { substrate: "talos", nodeIp: "192.168.0.5" },
    });
    expect(plex?.env?.ADVERTISE_IP).toBe("http://192.168.0.5:32400");
  });

  test("orbstack ADVERTISE_IP is still the mini's frozen LAN IP", () => {
    expect(plexOf(baseOpts)?.env?.ADVERTISE_IP).toBe("http://192.168.0.147:32400");
  });
});

// Task 4: component.ts's new optional WorkloadSpec fields (hostNetwork,
// dnsPolicy, runtimeClassName, resources.gpu) are additive , absent by
// default, so every EXISTING workload (api/worker/web/plex-on-orbstack/etc.)
// renders with none of these keys present at all (not merely `undefined`
// values leaking into the k8s object).
describe("renderWorkload: Task 4's GPU/hostNetwork fields are opt-in", () => {
  test("a spec with none of the new fields renders a pod spec without them", () => {
    const r = renderWorkload(api);
    const podSpec = r.deployment.spec.template.spec;
    expect(podSpec.hostNetwork).toBeUndefined();
    expect(podSpec.dnsPolicy).toBeUndefined();
    expect(podSpec.runtimeClassName).toBeUndefined();
    expect(r.deployment.spec.template.spec.containers[0].resources.limits["nvidia.com/gpu"]).toBe(
      undefined,
    );
  });

  test("hostNetwork + dnsPolicy + runtimeClassName + gpu all render onto the pod spec", () => {
    const spec: WorkloadSpec = {
      ...api,
      name: "home-assistant",
      resources: { memory: "1G", gpu: 1 },
      hostNetwork: true,
      dnsPolicy: "ClusterFirstWithHostNet",
      runtimeClassName: "nvidia",
    };
    const r = renderWorkload(spec);
    const podSpec = r.deployment.spec.template.spec;
    expect(podSpec.hostNetwork).toBe(true);
    expect(podSpec.dnsPolicy).toBe("ClusterFirstWithHostNet");
    expect(podSpec.runtimeClassName).toBe("nvidia");
    const limits = r.deployment.spec.template.spec.containers[0].resources.limits;
    const requests = r.deployment.spec.template.spec.containers[0].resources.requests;
    expect(limits["nvidia.com/gpu"]).toBe("1");
    // Extended resources require limits === requests (no GPU overcommit).
    expect(requests["nvidia.com/gpu"]).toBe("1");
  });
});
