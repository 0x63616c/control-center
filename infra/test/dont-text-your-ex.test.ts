import { describe, expect, test } from "vitest";
import { CLOUDFLARE_NAMESPACE, CLOUDFLARED_WORKLOAD_NAME } from "../src/cluster.ts";
import { renderWorkload } from "../src/component.ts";
import {
  DONT_TEXT_YOUR_EX_API_PORT,
  DONT_TEXT_YOUR_EX_API_WORKLOAD_NAME,
  DONT_TEXT_YOUR_EX_DATABASE,
  DONT_TEXT_YOUR_EX_HOSTNAME,
  DONT_TEXT_YOUR_EX_MODERATION_SECRET_NAME,
  DONT_TEXT_YOUR_EX_NAMESPACE,
  DONT_TEXT_YOUR_EX_NOTIFICATION_SECRET_NAME,
  dontTextYourExApiIngressPolicyArgs,
  dontTextYourExSpecs,
  dontTextYourExTemporalNamespaceSetupCommand,
} from "../src/dont-text-your-ex.ts";
import { serviceSpecs } from "../src/services.ts";

const VALID = `sha256:${"a".repeat(64)}`;
const ALL_DIGESTS = {
  "dont-text-your-ex-api": VALID,
  "dont-text-your-ex-frontend": VALID,
  "dont-text-your-ex-temporal-worker": VALID,
};

describe("Don't Text Your Ex production resources", () => {
  test("pins the production identity and database contract", () => {
    expect(DONT_TEXT_YOUR_EX_NAMESPACE).toBe("dont-text-your-ex");
    expect(DONT_TEXT_YOUR_EX_HOSTNAME).toBe("dont-text-your-ex.worldwidewebb.co");
    expect(DONT_TEXT_YOUR_EX_DATABASE).toMatchObject({
      clusterName: "dont-text-your-ex-postgres",
      databaseName: "text_your_ex",
      owner: "dont_text_your_ex",
      appSecretName: "dont-text-your-ex-postgres-app",
      rwServiceName: "dont-text-your-ex-postgres-rw",
    });
  });

  test("declares frontend, API, and the isolated Temporal worker", () => {
    const specs = dontTextYourExSpecs(ALL_DIGESTS, true);
    const frontend = specs.workloads.find((workload) => workload.name === "frontend");
    const api = specs.workloads.find((workload) => workload.name === "api");
    const worker = specs.workloads.find((workload) => workload.name === "temporal-worker");

    expect(frontend).toMatchObject({
      namespaceName: DONT_TEXT_YOUR_EX_NAMESPACE,
      image: `ghcr.io/0x63616c/www-dont-text-your-ex-frontend@${VALID}`,
      health: { path: "/", port: 80 },
    });
    expect(api).toMatchObject({
      namespaceName: DONT_TEXT_YOUR_EX_NAMESPACE,
      image: `ghcr.io/0x63616c/www-dont-text-your-ex-api@${VALID}`,
      health: { path: "/api/health", port: DONT_TEXT_YOUR_EX_API_PORT },
      env: {
        APP_ENV: "production",
        APPLE_BUNDLE_ID: "co.worldwidewebb.textyourex",
        POSTGRES_DB: "text_your_ex",
        POSTGRES_HOST: "dont-text-your-ex-postgres-rw",
        POSTGRES_PASSWORD_FILE: "/run/secrets/POSTGRES_PASSWORD",
        POSTGRES_USER: "dont_text_your_ex",
        MODERATION_NARRATIVE_KEYRING_FILE: "/run/moderation-secrets/MODERATION_NARRATIVE_KEYRING",
        TEMPORAL_ADDRESS: "temporal-server.temporal.svc.cluster.local:7233",
      },
      extraSecretMounts: [
        {
          secretName: "dont-text-your-ex-postgres-app",
          mountPath: "/run/secrets",
          items: [{ key: "password", path: "POSTGRES_PASSWORD" }],
        },
        {
          secretName: DONT_TEXT_YOUR_EX_NOTIFICATION_SECRET_NAME,
          mountPath: "/run/notification-secrets",
          items: [{ key: "PUSH_TOKEN_KEYRING", path: "PUSH_TOKEN_KEYRING" }],
        },
        {
          secretName: DONT_TEXT_YOUR_EX_MODERATION_SECRET_NAME,
          mountPath: "/run/moderation-secrets",
          items: [
            {
              key: "MODERATION_NARRATIVE_KEYRING",
              path: "MODERATION_NARRATIVE_KEYRING",
            },
          ],
        },
      ],
    });
    expect(worker).toMatchObject({
      namespaceName: "dont-text-your-ex",
      image: `ghcr.io/0x63616c/www-dont-text-your-ex-temporal-worker@${VALID}`,
      env: {
        APP_ENV: "production",
        TEMPORAL_NAMESPACE: "dont-text-your-ex",
        TEMPORAL_TASK_QUEUE: "main",
        TEMPORAL_ADDRESS: "temporal-server.temporal.svc.cluster.local:7233",
      },
      scrape: { port: 9464 },
      extraSecretMounts: [
        {
          secretName: "dont-text-your-ex-postgres-app",
          mountPath: "/run/secrets",
          items: [{ key: "password", path: "POSTGRES_PASSWORD" }],
        },
        {
          secretName: "dont-text-your-ex-notification-secrets",
          mountPath: "/run/notification-secrets",
          items: [
            { key: "APNS_KEY_ID", path: "APNS_KEY_ID" },
            { key: "APNS_TEAM_ID", path: "APNS_TEAM_ID" },
            { key: "APNS_KEY_CONTENT", path: "APNS_KEY_CONTENT" },
            { key: "PUSH_TOKEN_KEYRING", path: "PUSH_TOKEN_KEYRING" },
          ],
        },
      ],
    });
    if (!api) throw new Error("missing api workload");
    const rendered = renderWorkload(api);
    expect(rendered.deployment.spec.template.metadata.labels).toEqual({
      app: DONT_TEXT_YOUR_EX_API_WORKLOAD_NAME,
    });
    expect(rendered.services).toHaveLength(1);
    expect(rendered.services[0]).toMatchObject({
      metadata: { name: DONT_TEXT_YOUR_EX_API_WORKLOAD_NAME },
      spec: {
        type: "ClusterIP",
        selector: { app: DONT_TEXT_YOUR_EX_API_WORKLOAD_NAME },
        ports: [{ port: DONT_TEXT_YOUR_EX_API_PORT, targetPort: DONT_TEXT_YOUR_EX_API_PORT }],
      },
    });
    const container = rendered.deployment.spec.template.spec.containers[0];
    expect(container.startupProbe?.httpGet).toEqual({ path: "/api/health", port: 8787 });
    expect(container.readinessProbe?.httpGet).toEqual({ path: "/api/health", port: 8787 });
    expect(container.livenessProbe?.httpGet).toEqual({ path: "/api/health", port: 8787 });
  });

  test("allows API ingress only from the cloudflared workload", () => {
    const cloudflared = serviceSpecs({
      cloudflaredReplicas: 2,
      nasNfsServer: "192.168.0.218",
    }).find((workload) => workload.logicalName === "cloudflare-cloudflared");
    expect(cloudflared).toMatchObject({
      name: CLOUDFLARED_WORKLOAD_NAME,
      namespaceName: CLOUDFLARE_NAMESPACE,
    });
    if (!cloudflared) throw new Error("missing cloudflared workload");
    expect(renderWorkload(cloudflared).deployment.spec.template.metadata.labels).toEqual({
      app: CLOUDFLARED_WORKLOAD_NAME,
    });

    const policy = dontTextYourExApiIngressPolicyArgs();
    expect(policy.metadata).toEqual({
      name: "api-ingress-from-cloudflared",
      namespace: DONT_TEXT_YOUR_EX_NAMESPACE,
    });
    expect(policy.spec).toEqual({
      podSelector: { matchLabels: { app: DONT_TEXT_YOUR_EX_API_WORKLOAD_NAME } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": CLOUDFLARE_NAMESPACE },
              },
              podSelector: { matchLabels: { app: CLOUDFLARED_WORKLOAD_NAME } },
            },
          ],
          ports: [{ port: DONT_TEXT_YOUR_EX_API_PORT, protocol: "TCP" }],
        },
      ],
    });

    const peer = policy.spec.ingress?.[0]?.from?.[0];
    expect(peer && "ipBlock" in peer).toBe(false);
    expect("egress" in policy.spec).toBe(false);
  });

  test("registers its Temporal namespace with 90-day retention", () => {
    expect(dontTextYourExSpecs(ALL_DIGESTS, true).temporalNamespace).toEqual({
      name: "dont-text-your-ex",
      retention: "2160h",
      taskQueue: "main",
    });
    expect(dontTextYourExTemporalNamespaceSetupCommand()).toContain(
      "namespace create --namespace dont-text-your-ex --retention 2160h",
    );
    expect(dontTextYourExTemporalNamespaceSetupCommand()).toContain(
      "namespace update --namespace dont-text-your-ex --retention 2160h",
    );
    expect(dontTextYourExTemporalNamespaceSetupCommand()).toContain(
      "namespace describe --namespace dont-text-your-ex",
    );
  });

  test("declares a nightly, non-overlapping NAS backup with enforced 30-day retention", () => {
    const backup = dontTextYourExSpecs(ALL_DIGESTS, true).backup;
    expect(backup).toMatchObject({
      name: "dont-text-your-ex-pg-backup",
      namespaceName: DONT_TEXT_YOUR_EX_NAMESPACE,
      schedule: "15 1 * * *",
      extraSecretMounts: [
        { secretName: "dont-text-your-ex-postgres-app", mountPath: "/run/pgauth" },
      ],
      volumes: [
        {
          mountPath: "/backup",
          nfs: { server: "192.168.0.218", path: "/volume1/Homelab" },
          subPath: "backups/world-wide-webb/dont-text-your-ex/postgres",
        },
      ],
    });
    const command = backup.command?.join("\n") ?? "";
    expect(command).toContain("set -eo pipefail");
    expect(command).toContain("pg_dump -h dont-text-your-ex-postgres-rw");
    expect(command).toContain("find /backup -maxdepth 1 -type f");
    expect(command).toContain("-name 'text_your_ex-????????.sql.gz'");
    expect(command).toContain("-mmin +43200 -print -delete");
  });

  test("refuses mutable or malformed image references for the production stack", () => {
    expect(() => dontTextYourExSpecs({}, true)).toThrow(/imageDigests/);
    expect(() =>
      dontTextYourExSpecs({ ...ALL_DIGESTS, "dont-text-your-ex-api": "latest" }, true),
    ).toThrow(/sha256/);
  });
});
