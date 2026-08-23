import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { DEFAULT_METRICS_PORT } from "@www/platform/metrics/port";
import type { InfraNamespaceName } from "./cluster.ts";
import type { CronJobSpec, WorkloadSpec } from "./component.ts";
import { ScheduledJob, Workload } from "./component.ts";
import { GHCR_PULL_SECRET_NAME } from "./ghcr-pull-secrets.ts";
import type { ImageDigests } from "./services.ts";
import {
  TEMPORAL_ADMIN_TOOLS_IMAGE,
  TEMPORAL_FRONTEND_CLUSTER_ADDRESS,
} from "./temporal-constants.ts";

export const DONT_TEXT_YOUR_EX_NAMESPACE = "dont-text-your-ex" as const;
export const DONT_TEXT_YOUR_EX_HOSTNAME = "dont-text-your-ex.worldwidewebb.co";
export const DONT_TEXT_YOUR_EX_API_PORT = 8787;
export const DONT_TEXT_YOUR_EX_NOTIFICATION_SECRET_NAME = "dont-text-your-ex-notification-secrets";
export const DONT_TEXT_YOUR_EX_ACCOUNT_DELETION_SECRET_NAME =
  "dont-text-your-ex-account-deletion-secrets";
const DONT_TEXT_YOUR_EX_FRONTEND_PORT = 80;

export const DONT_TEXT_YOUR_EX_DATABASE = {
  clusterName: "dont-text-your-ex-postgres",
  databaseName: "text_your_ex",
  owner: "dont_text_your_ex",
  appSecretName: "dont-text-your-ex-postgres-app",
  rwServiceName: "dont-text-your-ex-postgres-rw",
} as const;

export const DONT_TEXT_YOUR_EX_IMAGE_DIGEST_KEYS = [
  "dont-text-your-ex-api",
  "dont-text-your-ex-frontend",
  "dont-text-your-ex-temporal-worker",
] as const;

type OwnedWorkloadSpec = WorkloadSpec & { namespaceName: InfraNamespaceName };
type OwnedCronJobSpec = CronJobSpec & { namespaceName: InfraNamespaceName };

function image(component: "api" | "frontend" | "temporal-worker", digests: ImageDigests): string {
  const key = `dont-text-your-ex-${component}`;
  const repository = `ghcr.io/0x63616c/www-dont-text-your-ex-${component}`;
  const digest = digests[key];
  if (digest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`imageDigests.${key} is not a sha256:<64-hex> digest: ${digest}`);
  }
  return digest ? `${repository}@${digest}` : `${repository}:main`;
}

export function dontTextYourExSpecs(
  imageDigests: ImageDigests,
  requireImageDigestPins: boolean,
  nasNfsServer = "192.168.0.218",
): {
  workloads: OwnedWorkloadSpec[];
  backup: OwnedCronJobSpec;
  temporalNamespace: { name: string; retention: string; taskQueue: string };
} {
  if (requireImageDigestPins) {
    const missing = DONT_TEXT_YOUR_EX_IMAGE_DIGEST_KEYS.filter((key) => !imageDigests[key]);
    if (missing.length > 0) {
      throw new Error(
        `prod stack requires wwwinfra:imageDigests pins for dont-text-your-ex images; missing: ${missing.join(", ")}`,
      );
    }
  }

  const workloads: OwnedWorkloadSpec[] = [
    {
      logicalName: "dont-text-your-ex-frontend",
      name: "frontend",
      namespaceName: DONT_TEXT_YOUR_EX_NAMESPACE,
      image: image("frontend", imageDigests),
      replicas: 1,
      resources: { memory: "128M", reserveCpus: "0.1" },
      ports: [{ containerPort: DONT_TEXT_YOUR_EX_FRONTEND_PORT, expose: "cluster" }],
      health: { path: "/", port: DONT_TEXT_YOUR_EX_FRONTEND_PORT },
      imagePullSecrets: [GHCR_PULL_SECRET_NAME],
    },
    {
      logicalName: "dont-text-your-ex-api",
      name: "api",
      namespaceName: DONT_TEXT_YOUR_EX_NAMESPACE,
      image: image("api", imageDigests),
      replicas: 1,
      resources: { memory: "512M", reserveCpus: "0.25" },
      ports: [{ containerPort: DONT_TEXT_YOUR_EX_API_PORT, expose: "cluster" }],
      health: { path: "/api/health", port: DONT_TEXT_YOUR_EX_API_PORT },
      env: {
        NODE_ENV: "production",
        APP_ENV: "production",
        PORT: String(DONT_TEXT_YOUR_EX_API_PORT),
        POSTGRES_HOST: DONT_TEXT_YOUR_EX_DATABASE.rwServiceName,
        POSTGRES_PORT: "5432",
        POSTGRES_USER: DONT_TEXT_YOUR_EX_DATABASE.owner,
        POSTGRES_DB: DONT_TEXT_YOUR_EX_DATABASE.databaseName,
        POSTGRES_PASSWORD_FILE: "/run/secrets/POSTGRES_PASSWORD",
        APPLE_BUNDLE_ID: "co.worldwidewebb.textyourex",
        TEMPORAL_ADDRESS: TEMPORAL_FRONTEND_CLUSTER_ADDRESS,
        PUSH_TOKEN_KEYRING_FILE: "/run/notification-secrets/PUSH_TOKEN_KEYRING",
        ACCOUNT_DELETION_KEYRING_FILE: "/run/account-deletion-secrets/ACCOUNT_DELETION_KEYRING",
        ERASURE_JOURNAL_DIR: "/erasure-journal",
      },
      extraSecretMounts: [
        {
          secretName: DONT_TEXT_YOUR_EX_DATABASE.appSecretName,
          mountPath: "/run/secrets",
          items: [{ key: "password", path: "POSTGRES_PASSWORD" }],
        },
        {
          secretName: DONT_TEXT_YOUR_EX_NOTIFICATION_SECRET_NAME,
          mountPath: "/run/notification-secrets",
          items: [{ key: "PUSH_TOKEN_KEYRING", path: "PUSH_TOKEN_KEYRING" }],
        },
        {
          secretName: DONT_TEXT_YOUR_EX_ACCOUNT_DELETION_SECRET_NAME,
          mountPath: "/run/account-deletion-secrets",
          items: [
            { key: "ACCOUNT_DELETION_KEYRING", path: "ACCOUNT_DELETION_KEYRING" },
            {
              key: "RESTORE_TOMBSTONE_HMAC_KEYRING",
              path: "RESTORE_TOMBSTONE_HMAC_KEYRING",
            },
            {
              key: "RESTORE_TOMBSTONE_SIGNING_KEYRING",
              path: "RESTORE_TOMBSTONE_SIGNING_KEYRING",
            },
          ],
        },
      ],
      volumes: [
        {
          mountPath: "/erasure-journal",
          nfs: { server: nasNfsServer, path: "/volume1/Homelab" },
          subPath: "backups/world-wide-webb/dont-text-your-ex/erasure-journal",
        },
      ],
      imagePullSecrets: [GHCR_PULL_SECRET_NAME],
    },
    {
      logicalName: "dont-text-your-ex-temporal-worker",
      name: "temporal-worker",
      namespaceName: DONT_TEXT_YOUR_EX_NAMESPACE,
      image: image("temporal-worker", imageDigests),
      replicas: 1,
      resources: { memory: "512M", reserveCpus: "0.1", reserveMemory: "256Mi" },
      env: {
        APP_ENV: "production",
        TEMPORAL_ADDRESS: TEMPORAL_FRONTEND_CLUSTER_ADDRESS,
        TEMPORAL_NAMESPACE: DONT_TEXT_YOUR_EX_NAMESPACE,
        TEMPORAL_TASK_QUEUE: "main",
        POSTGRES_HOST: DONT_TEXT_YOUR_EX_DATABASE.rwServiceName,
        POSTGRES_PORT: "5432",
        POSTGRES_USER: DONT_TEXT_YOUR_EX_DATABASE.owner,
        POSTGRES_DB: DONT_TEXT_YOUR_EX_DATABASE.databaseName,
        POSTGRES_PASSWORD_FILE: "/run/secrets/POSTGRES_PASSWORD",
        APPLE_BUNDLE_ID: "co.worldwidewebb.textyourex",
        ERASURE_JOURNAL_DIR: "/erasure-journal",
      },
      scrape: { port: DEFAULT_METRICS_PORT },
      extraSecretMounts: [
        {
          secretName: DONT_TEXT_YOUR_EX_DATABASE.appSecretName,
          mountPath: "/run/secrets",
          items: [{ key: "password", path: "POSTGRES_PASSWORD" }],
        },
        {
          secretName: DONT_TEXT_YOUR_EX_NOTIFICATION_SECRET_NAME,
          mountPath: "/run/notification-secrets",
          items: [
            { key: "APNS_KEY_ID", path: "APNS_KEY_ID" },
            { key: "APNS_TEAM_ID", path: "APNS_TEAM_ID" },
            { key: "APNS_KEY_CONTENT", path: "APNS_KEY_CONTENT" },
            { key: "PUSH_TOKEN_KEYRING", path: "PUSH_TOKEN_KEYRING" },
          ],
        },
        {
          secretName: DONT_TEXT_YOUR_EX_ACCOUNT_DELETION_SECRET_NAME,
          mountPath: "/run/account-deletion-secrets",
          items: [
            { key: "SIWA_KEY_ID", path: "SIWA_KEY_ID" },
            { key: "SIWA_TEAM_ID", path: "SIWA_TEAM_ID" },
            { key: "SIWA_KEY_CONTENT", path: "SIWA_KEY_CONTENT" },
            { key: "ACCOUNT_DELETION_KEYRING", path: "ACCOUNT_DELETION_KEYRING" },
            {
              key: "RESTORE_TOMBSTONE_HMAC_KEYRING",
              path: "RESTORE_TOMBSTONE_HMAC_KEYRING",
            },
            {
              key: "RESTORE_TOMBSTONE_SIGNING_KEYRING",
              path: "RESTORE_TOMBSTONE_SIGNING_KEYRING",
            },
          ],
        },
      ],
      volumes: [
        {
          mountPath: "/erasure-journal",
          nfs: { server: nasNfsServer, path: "/volume1/Homelab" },
          subPath: "backups/world-wide-webb/dont-text-your-ex/erasure-journal",
        },
      ],
      imagePullSecrets: [GHCR_PULL_SECRET_NAME],
    },
  ];

  const backup: OwnedCronJobSpec = {
    name: "dont-text-your-ex-pg-backup",
    namespaceName: DONT_TEXT_YOUR_EX_NAMESPACE,
    image: "ghcr.io/cloudnative-pg/postgresql:18",
    schedule: "15 1 * * *",
    activeDeadlineSeconds: 3600,
    command: [
      "bash",
      "-c",
      [
        "set -eo pipefail",
        'export PGPASSWORD="$(cat /run/pgauth/password)"',
        'out="/backup/text_your_ex-$(date +%Y%m%d).sql.gz"',
        `pg_dump -h ${DONT_TEXT_YOUR_EX_DATABASE.rwServiceName} -U ${DONT_TEXT_YOUR_EX_DATABASE.owner} -d ${DONT_TEXT_YOUR_EX_DATABASE.databaseName} | gzip -c > "$out"`,
        'echo "wrote $out"',
        "find /backup -maxdepth 1 -type f -name 'text_your_ex-????????.sql.gz' -mmin +43200 -print -delete",
      ].join("\n"),
    ],
    env: { TZ: "America/Los_Angeles" },
    extraSecretMounts: [
      { secretName: DONT_TEXT_YOUR_EX_DATABASE.appSecretName, mountPath: "/run/pgauth" },
    ],
    volumes: [
      {
        mountPath: "/backup",
        nfs: { server: nasNfsServer, path: "/volume1/Homelab" },
        subPath: "backups/world-wide-webb/dont-text-your-ex/postgres",
      },
    ],
  };

  return {
    workloads,
    backup,
    temporalNamespace: {
      name: DONT_TEXT_YOUR_EX_NAMESPACE,
      retention: "2160h",
      taskQueue: "main",
    },
  };
}

export interface DontTextYourExArgs {
  provider: k8s.Provider;
  namespace: pulumi.Input<string>;
  cnpgOperator: k8s.yaml.ConfigFile;
  imageDigests: ImageDigests;
  requireImageDigestPins: boolean;
  nasNfsServer: string;
  vault: Record<string, string>;
}

const NOTIFICATION_VAULT_KEYS = {
  APNS_KEY_ID: "APNS_AUTH_KEY__KEY_ID",
  APNS_TEAM_ID: "APNS_AUTH_KEY__TEAM_ID",
  APNS_KEY_CONTENT: "APNS_AUTH_KEY__P8_CONTENT",
  PUSH_TOKEN_KEYRING: "DTYE_PUSH_TOKEN_KEYRING",
} as const;

const ACCOUNT_DELETION_VAULT_KEYS = {
  SIWA_KEY_ID: "DTYE_SIWA_KEY_ID",
  SIWA_TEAM_ID: "DTYE_SIWA_TEAM_ID",
  SIWA_KEY_CONTENT: "DTYE_SIWA_KEY_CONTENT",
  ACCOUNT_DELETION_KEYRING: "DTYE_ACCOUNT_DELETION_KEYRING",
  RESTORE_TOMBSTONE_HMAC_KEYRING: "DTYE_RESTORE_TOMBSTONE_HMAC_KEYRING",
  RESTORE_TOMBSTONE_SIGNING_KEYRING: "DTYE_RESTORE_TOMBSTONE_SIGNING_KEYRING",
} as const;

function notificationSecretData(vault: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(NOTIFICATION_VAULT_KEYS).map(([name, vaultKey]) => {
      const value = vault[vaultKey];
      if (value === undefined) {
        throw new Error(`vault key "${vaultKey}" not found (needed by DTYE/${name})`);
      }
      return [name, pulumi.secret(value)];
    }),
  );
}

function accountDeletionSecretData(vault: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(ACCOUNT_DELETION_VAULT_KEYS).map(([name, vaultKey]) => {
      const value = vault[vaultKey];
      if (value === undefined) {
        throw new Error(`vault key "${vaultKey}" not found (needed by DTYE/${name})`);
      }
      return [name, pulumi.secret(value)];
    }),
  );
}

export function dontTextYourExTemporalNamespaceSetupCommand(): string {
  return [
    "set -eu",
    `export TEMPORAL_ADDRESS=${TEMPORAL_FRONTEND_CLUSTER_ADDRESS}`,
    "until temporal operator cluster health >/dev/null 2>&1; do sleep 2; done",
    "temporal operator namespace create --namespace dont-text-your-ex --retention 2160h || true",
    "temporal operator namespace update --namespace dont-text-your-ex --retention 2160h",
    "temporal operator namespace describe --namespace dont-text-your-ex",
  ].join("\n");
}

export function installDontTextYourEx(args: DontTextYourExArgs) {
  const {
    provider,
    namespace,
    cnpgOperator,
    imageDigests,
    requireImageDigestPins,
    nasNfsServer,
    vault,
  } = args;
  const specs = dontTextYourExSpecs(imageDigests, requireImageDigestPins, nasNfsServer);
  const temporalNamespaceJob = new k8s.batch.v1.Job(
    "temporal-namespace-dont-text-your-ex",
    {
      metadata: { name: "temporal-namespace-dont-text-your-ex", namespace },
      spec: {
        backoffLimit: 6,
        template: {
          metadata: { labels: { app: "temporal-namespace-setup" } },
          spec: {
            restartPolicy: "Never",
            automountServiceAccountToken: false,
            containers: [
              {
                name: "namespace",
                image: TEMPORAL_ADMIN_TOOLS_IMAGE,
                command: ["/bin/sh", "-c", dontTextYourExTemporalNamespaceSetupCommand()],
                resources: {
                  limits: { memory: "512Mi" },
                  requests: { cpu: "100m", memory: "128Mi" },
                },
              },
            ],
          },
        },
      },
    },
    { provider, replaceOnChanges: ["spec"], deleteBeforeReplace: true },
  );
  const cluster = new k8s.apiextensions.CustomResource(
    DONT_TEXT_YOUR_EX_DATABASE.clusterName,
    {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: { name: DONT_TEXT_YOUR_EX_DATABASE.clusterName, namespace },
      spec: {
        instances: 1,
        bootstrap: {
          initdb: {
            database: DONT_TEXT_YOUR_EX_DATABASE.databaseName,
            owner: DONT_TEXT_YOUR_EX_DATABASE.owner,
          },
        },
        storage: { storageClass: "local-lvm", size: "2Gi" },
        resources: {
          requests: { cpu: "100m", memory: "256Mi" },
          limits: { memory: "512Mi" },
        },
      },
    },
    { provider, dependsOn: [cnpgOperator] },
  );
  const notificationSecret = new k8s.core.v1.Secret(
    DONT_TEXT_YOUR_EX_NOTIFICATION_SECRET_NAME,
    {
      metadata: { name: DONT_TEXT_YOUR_EX_NOTIFICATION_SECRET_NAME, namespace },
      stringData: notificationSecretData(vault),
    },
    { provider },
  );
  const accountDeletionSecret = new k8s.core.v1.Secret(
    DONT_TEXT_YOUR_EX_ACCOUNT_DELETION_SECRET_NAME,
    {
      metadata: { name: DONT_TEXT_YOUR_EX_ACCOUNT_DELETION_SECRET_NAME, namespace },
      stringData: accountDeletionSecretData(vault),
    },
    { provider },
  );

  const workloads = specs.workloads.map(
    ({ namespaceName: _namespaceName, ...spec }) =>
      new Workload(
        { ...spec, provider, namespace },
        {
          provider,
          dependsOn:
            spec.name === "temporal-worker"
              ? [cluster, temporalNamespaceJob, notificationSecret, accountDeletionSecret]
              : spec.name === "api"
                ? [cluster, notificationSecret, accountDeletionSecret]
                : undefined,
        },
      ),
  );
  const { namespaceName: _namespaceName, ...backupSpec } = specs.backup;
  const backup = new ScheduledJob(
    { ...backupSpec, provider, namespace },
    { provider, dependsOn: [cluster] },
  );
  return {
    cluster,
    temporalNamespaceJob,
    notificationSecret,
    accountDeletionSecret,
    workloads,
    backup,
  };
}
