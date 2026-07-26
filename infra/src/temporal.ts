// Temporal, hand-written. No Helm chart, no operator-owned cluster: every
// object below is a plain k8s resource this program renders directly, so the
// shape of the deployment is readable in one file and versioned with the code
// that talks to it.
//
// What lives in the `temporal` namespace (L1: NOT in cluster.ts's closed
// InfraNamespaceName map — this module creates it, the same way
// homeassistant.ts owns its own):
//   1. `temporal-postgres`, its OWN single-instance CNPG Cluster, holding BOTH
//      stores Temporal needs: `temporal` (history/mutable state) and
//      `temporal_visibility` (the searchable index behind the UI's list views).
//      Two databases, one instance — they are written by the same process, so
//      splitting the instance would buy isolation from nothing.
//   2. `temporal-schema-setup`, a Job that installs/updates BOTH schemas with
//      `temporal-sql-tool` before any server pod starts. This is the half of
//      the `temporalio/auto-setup` image worth keeping: auto-setup does schema
//      work from INSIDE the server container, which with >1 replica means two
//      pods racing the same migration on every boot.
//   3. `temporal-server`, 2 replicas of the combined frontend+history+matching+
//      worker process. Replicas find each other through the `cluster_membership`
//      table in Postgres, each broadcasting the pod IP the image's entrypoint
//      derives from its own hostname.
//   4. `temporal-namespace-setup`, a Job registering the `control-center`
//      Temporal namespace once the frontend answers.
//   5. `temporal-ui`, the web UI, and `temporal-worker`, our TypeScript worker
//      (apps/temporal-worker) polling the `main` task queue.
//
// HONEST LIMIT on "2 replicas for redundancy": this cluster is a SINGLE node.
// Two replicas survive a pod crash, an OOM kill, and a rolling restart — they
// do not survive the node going down, and no arrangement of replicas can while
// there is one machine.
//
// TALOS-ONLY: a no-op unless installTemporal() is called, which program.ts only
// does behind `substrate === "talos"`.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GHCR_PULL_SECRET_NAME } from "./ghcr-pull-secrets.ts";
import { composeGhcrDockerConfigJson, ghcrImage, type ImageDigests } from "./services.ts";

/** The k8s namespace everything Temporal lives in. */
export const TEMPORAL_NAMESPACE = "temporal";

/**
 * The Temporal-level namespace (NOT the k8s one) our workflows run in, and the
 * task queue they poll. These are the two names the worker's env defaults must
 * agree with (packages/platform/env/manifest.ts) — they are the contract
 * between this file and apps/temporal-worker.
 */
export const TEMPORAL_CLUSTER_NAMESPACE = "control-center";
export const TEMPORAL_TASK_QUEUE = "main";

/** In-cluster address of the frontend's gRPC port. */
export const TEMPORAL_FRONTEND_SERVICE = "temporal-server";
const FRONTEND_GRPC_PORT = 7233;
const FRONTEND_HTTP_PORT = 7243;
const UI_PORT = 8080;

// Image pins. `server` and `admin-tools` MUST move together: the schema the Job
// installs is the schema the server expects.
const TEMPORAL_VERSION = "1.31.2";
const SERVER_IMAGE = `temporalio/server:${TEMPORAL_VERSION}`;
const ADMIN_TOOLS_IMAGE = `temporalio/admin-tools:${TEMPORAL_VERSION}`;
const UI_IMAGE = "temporalio/ui:2.52.1";

// Postgres. `postgres12` is Temporal's plugin name for "PostgreSQL 12 or
// newer", not a pin to 12 — CNPG runs 17.
const DB_PLUGIN = "postgres12";
const CNPG_CLUSTER_NAME = "temporal-postgres";
const CNPG_RW_SERVICE_NAME = `${CNPG_CLUSTER_NAME}-rw`;
// CNPG mints this Secret itself from bootstrap.initdb (keys: username,
// password, …). Deliberately NOT a vault key: nothing outside the cluster ever
// connects to this database, so the credential never needs to exist anywhere a
// human could read it.
const CNPG_APP_SECRET_NAME = `${CNPG_CLUSTER_NAME}-app`;
const DATABASE_OWNER = "temporal";
const DATABASE_NAME = "temporal";
const VISIBILITY_DATABASE_NAME = "temporal_visibility";
const DATABASE_PORT = "5432";

// Bounded wait for Postgres in the schema Job: ~2 minutes, then fail the Job.
const DB_WAIT_MAX_ATTEMPTS = 60;
const DB_WAIT_INTERVAL_SECONDS = 2;

// History shards are FIXED AT CREATION — changing this on a cluster that holds
// data is not a migration, it is a new cluster. 512 is the standard small-
// production value: enough headroom to grow into, cheap to poll at this size.
const NUM_HISTORY_SHARDS = "512";

const DYNAMIC_CONFIG_MAP_NAME = "temporal-dynamic-config";
const DYNAMIC_CONFIG_MOUNT = "/etc/temporal/dynamicconfig";
const DYNAMIC_CONFIG_FILE = `${DYNAMIC_CONFIG_MOUNT}/docker.yaml`;

// Retention for the control-center namespace: how long a CLOSED workflow's
// history is queryable. HealthCheckWorkflow closes 1440 runs a day, so a long
// window is mostly noise; 3 days is enough to answer "was it healthy over the
// weekend" without carrying a month of one-minute heartbeats.
const NAMESPACE_RETENTION = "72h";

export interface TemporalArgs {
  provider: k8s.Provider;
  // The already-installed CNPG operator (cnpg.ts's installCnpg().operator): its
  // CRDs/webhooks are cluster-scoped singletons shared by every CNPG Cluster.
  cnpgOperator: k8s.yaml.ConfigFile;
  // Decrypted vault (vault.ts) — used ONLY for the GHCR pull token, since the
  // temporal-worker image is private. Temporal's own DB credential is minted by
  // CNPG in-cluster (see CNPG_APP_SECRET_NAME).
  vault: Record<string, string>;
  // Per-service GHCR digest pins from CI, for the temporal-worker image.
  imageDigests: ImageDigests;
}

export interface TemporalResources {
  namespace: k8s.core.v1.Namespace;
  ghcrPullSecret: k8s.core.v1.Secret;
  cluster: k8s.apiextensions.CustomResource;
  dynamicConfig: k8s.core.v1.ConfigMap;
  schemaJob: k8s.batch.v1.Job;
  server: k8s.apps.v1.Deployment;
  serverService: k8s.core.v1.Service;
  namespaceJob: k8s.batch.v1.Job;
  ui: k8s.apps.v1.Deployment;
  uiService: k8s.core.v1.Service;
  worker: k8s.apps.v1.Deployment;
}

/** The DB password, read from the CNPG-managed Secret rather than any env dump. */
function databasePasswordEnv(name: string): k8s.types.input.core.v1.EnvVar {
  return {
    name,
    valueFrom: { secretKeyRef: { name: CNPG_APP_SECRET_NAME, key: "password" } },
  };
}

/**
 * The env the server image's config template reads. The entrypoint fills in
 * BIND_ON_IP + TEMPORAL_BROADCAST_ADDRESS from the pod's own hostname, which is
 * exactly the per-replica identity ringpop membership needs — so neither is set
 * here, and setting them would break the 2-replica ring.
 */
function serverEnv(): k8s.types.input.core.v1.EnvVar[] {
  return [
    { name: "DB", value: DB_PLUGIN },
    { name: "POSTGRES_SEEDS", value: CNPG_RW_SERVICE_NAME },
    { name: "DB_PORT", value: DATABASE_PORT },
    { name: "POSTGRES_USER", value: DATABASE_OWNER },
    databasePasswordEnv("POSTGRES_PWD"),
    { name: "DBNAME", value: DATABASE_NAME },
    { name: "VISIBILITY_DBNAME", value: VISIBILITY_DATABASE_NAME },
    { name: "NUM_HISTORY_SHARDS", value: NUM_HISTORY_SHARDS },
    // All four roles in one process, per the ask ("1 worker =
    // history/frontend/combined etc"). Splitting them into separate Deployments
    // is the scale-out move; at this size it would only add failure modes.
    { name: "SERVICES", value: "frontend:history:matching:worker" },
    // publicClient: how the internal worker role dials the frontend. Left to
    // default it would be this pod's own IP; the Service load-balances across
    // both replicas instead.
    {
      name: "PUBLIC_FRONTEND_ADDRESS",
      value: `${TEMPORAL_FRONTEND_SERVICE}:${FRONTEND_GRPC_PORT}`,
    },
    { name: "DYNAMIC_CONFIG_FILE_PATH", value: DYNAMIC_CONFIG_FILE },
    { name: "LOG_LEVEL", value: "info" },
  ];
}

/** `temporal-sql-tool` flags shared by every schema command. */
function sqlToolFlags(database: string): string {
  return [
    `--plugin ${DB_PLUGIN}`,
    `--ep ${CNPG_RW_SERVICE_NAME}`,
    `-p ${DATABASE_PORT}`,
    `-u ${DATABASE_OWNER}`,
    `--db ${database}`,
  ].join(" ");
}

/**
 * Install-or-update both schemas. Idempotent by construction, because it runs
 * again on every version bump:
 *   - `setup-schema -v 0.0` seeds the version tables and is the ONLY step that
 *     legitimately fails on an already-initialised database, hence the `|| true`.
 *   - `update-schema` then applies whatever versioned migrations are missing,
 *     and is NOT tolerated failing — a broken schema must fail the Job (and so
 *     the deploy) rather than leave the server crash-looping against it.
 *
 * The readiness gate is a plain TCP probe with `nc`, not a `temporal-sql-tool`
 * subcommand: 1.31.2's sql tool has exactly four commands (setup-schema,
 * update-schema, create-database, drop-database) and no `ping`, so an earlier
 * `until … ping` loop spun forever on a healthy database. The probe is also
 * bounded — an unreachable Postgres must fail the Job (and the deploy) instead
 * of leaving it Running indefinitely, which is how that bug hid.
 */
function schemaSetupScript(): string {
  const schemaRoot = "/etc/temporal/schema/postgresql/v12";
  return [
    "set -eu",
    'echo "waiting for postgres…"',
    `attempt=0`,
    `until nc -z ${CNPG_RW_SERVICE_NAME} ${DATABASE_PORT}; do`,
    `  attempt=$((attempt + 1))`,
    `  if [ "$attempt" -ge ${DB_WAIT_MAX_ATTEMPTS} ]; then`,
    `    echo "postgres ${CNPG_RW_SERVICE_NAME}:${DATABASE_PORT} unreachable after ${DB_WAIT_MAX_ATTEMPTS} attempts" >&2`,
    `    exit 1`,
    `  fi`,
    `  sleep ${DB_WAIT_INTERVAL_SECONDS}`,
    `done`,
    `temporal-sql-tool ${sqlToolFlags(DATABASE_NAME)} setup-schema -v 0.0 || true`,
    `temporal-sql-tool ${sqlToolFlags(DATABASE_NAME)} update-schema -d ${schemaRoot}/temporal/versioned`,
    `temporal-sql-tool ${sqlToolFlags(VISIBILITY_DATABASE_NAME)} setup-schema -v 0.0 || true`,
    `temporal-sql-tool ${sqlToolFlags(VISIBILITY_DATABASE_NAME)} update-schema -d ${schemaRoot}/visibility/versioned`,
    'echo "schema up to date"',
  ].join("\n");
}

/**
 * Register the Temporal namespace our workflows run in. `namespace create`
 * returns AlreadyExists on every deploy after the first, which is a success for
 * our purposes — but the `describe` that follows is NOT tolerated failing, so a
 * genuinely absent namespace still fails the Job instead of passing silently.
 */
function namespaceSetupScript(): string {
  const address = `${TEMPORAL_FRONTEND_SERVICE}:${FRONTEND_GRPC_PORT}`;
  return [
    "set -eu",
    `export TEMPORAL_ADDRESS=${address}`,
    'echo "waiting for temporal frontend…"',
    "until temporal operator cluster health >/dev/null 2>&1; do sleep 2; done",
    `temporal operator namespace create --namespace ${TEMPORAL_CLUSTER_NAMESPACE} --retention ${NAMESPACE_RETENTION} || true`,
    `temporal operator namespace describe --namespace ${TEMPORAL_CLUSTER_NAMESPACE}`,
  ].join("\n");
}

const serverLabels = { app: TEMPORAL_FRONTEND_SERVICE };
const uiLabels = { app: "temporal-ui" };
const workerLabels = { app: "temporal-worker" };

/**
 * @public - installs the temporal namespace, its Postgres, the hand-written
 * server/UI Deployments, the schema + namespace bootstrap Jobs, and our
 * TypeScript worker. Consumed by program.ts, gated to the "talos" substrate.
 */
export function installTemporal(args: TemporalArgs): TemporalResources {
  const { provider, cnpgOperator, vault, imageDigests } = args;
  const opts = { provider };

  const namespace = new k8s.core.v1.Namespace(
    TEMPORAL_NAMESPACE,
    { metadata: { name: TEMPORAL_NAMESPACE } },
    opts,
  );
  const namespaceName = namespace.metadata.name;
  const inNamespace = { ...opts, dependsOn: [namespace] };

  // The temporal-worker image is private on GHCR, so this namespace needs its
  // own copy of the pull secret (a Secret is always namespace-local).
  const pat = vault.GITHUB_PERSONAL_ACCESS_TOKEN__TOKEN;
  if (!pat) throw new Error("temporal: vault key GITHUB_PERSONAL_ACCESS_TOKEN__TOKEN not found");
  const ghcrPullSecret = new k8s.core.v1.Secret(
    "temporal-ghcr-pull",
    {
      metadata: { name: GHCR_PULL_SECRET_NAME, namespace: namespaceName },
      type: "kubernetes.io/dockerconfigjson",
      stringData: { ".dockerconfigjson": pulumi.secret(composeGhcrDockerConfigJson(pat)) },
    },
    inNamespace,
  );

  const cluster = new k8s.apiextensions.CustomResource(
    CNPG_CLUSTER_NAME,
    {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: { name: CNPG_CLUSTER_NAME, namespace: namespaceName },
      spec: {
        instances: 1,
        bootstrap: {
          initdb: {
            database: DATABASE_NAME,
            owner: DATABASE_OWNER,
            // The visibility store is a SECOND database, created here because
            // `initdb` only makes one. postInitSQL runs as superuser against
            // the `postgres` database at bootstrap, which is the only place a
            // `CREATE DATABASE` can run (it cannot run inside a transaction
            // block in the app database).
            postInitSQL: [`CREATE DATABASE ${VISIBILITY_DATABASE_NAME} OWNER ${DATABASE_OWNER}`],
          },
        },
        storage: { storageClass: "local-path", size: "10Gi" },
        resources: {
          limits: { memory: "1Gi" },
          requests: { cpu: "250m", memory: "512Mi" },
        },
      },
    },
    { ...inNamespace, dependsOn: [namespace, cnpgOperator] },
  );

  const dynamicConfig = new k8s.core.v1.ConfigMap(
    DYNAMIC_CONFIG_MAP_NAME,
    {
      metadata: { name: DYNAMIC_CONFIG_MAP_NAME, namespace: namespaceName },
      // Explicit and empty-by-intent: the server REQUIRES the file to exist, and
      // we want every knob at its documented default until something concrete
      // justifies overriding it. maxIDLength matches the docker default.
      data: {
        "docker.yaml": ["limit.maxIDLength:", "  - value: 255", "    constraints: {}", ""].join(
          "\n",
        ),
      },
    },
    inNamespace,
  );

  // Job names carry the version: a k8s Job's pod template is immutable, so the
  // schema migration for a NEW Temporal version has to arrive as a new Job.
  const schemaJobName = `temporal-schema-setup-${TEMPORAL_VERSION.replace(/\./g, "-")}`;
  const schemaJob = new k8s.batch.v1.Job(
    schemaJobName,
    {
      metadata: { name: schemaJobName, namespace: namespaceName },
      spec: {
        backoffLimit: 6,
        template: {
          metadata: { labels: { app: "temporal-schema-setup" } },
          spec: {
            restartPolicy: "Never",
            automountServiceAccountToken: false,
            containers: [
              {
                name: "schema",
                image: ADMIN_TOOLS_IMAGE,
                command: ["/bin/sh", "-c", schemaSetupScript()],
                // temporal-sql-tool reads the password from SQL_PASSWORD.
                env: [databasePasswordEnv("SQL_PASSWORD")],
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
    {
      ...inNamespace,
      dependsOn: [cluster],
      // A Job's pod template is immutable, so editing the migration script for
      // an UNCHANGED Temporal version (a fix to the script itself, not a
      // version bump) can only ship as a replacement. The name is fixed, hence
      // delete-before-replace rather than the default create-then-delete.
      replaceOnChanges: ["spec"],
      deleteBeforeReplace: true,
    },
  );

  const server = new k8s.apps.v1.Deployment(
    "temporal-server",
    {
      metadata: {
        name: TEMPORAL_FRONTEND_SERVICE,
        namespace: namespaceName,
        labels: serverLabels,
      },
      spec: {
        // Two, per the ask. See the file header on what that does and does not
        // buy on a single-node cluster.
        replicas: 2,
        selector: { matchLabels: serverLabels },
        template: {
          metadata: { labels: serverLabels },
          spec: {
            automountServiceAccountToken: false,
            containers: [
              {
                name: "temporal-server",
                image: SERVER_IMAGE,
                env: serverEnv(),
                ports: [
                  { name: "grpc", containerPort: FRONTEND_GRPC_PORT },
                  { name: "http", containerPort: FRONTEND_HTTP_PORT },
                ],
                volumeMounts: [{ name: "dynamic-config", mountPath: DYNAMIC_CONFIG_MOUNT }],
                // TCP, not gRPC-health: the frontend answers on :7233 only once
                // it has membership and persistence, which is exactly the
                // condition worth gating traffic on.
                readinessProbe: {
                  tcpSocket: { port: FRONTEND_GRPC_PORT },
                  initialDelaySeconds: 10,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  tcpSocket: { port: FRONTEND_GRPC_PORT },
                  initialDelaySeconds: 60,
                  periodSeconds: 30,
                },
                resources: {
                  limits: { memory: "1Gi" },
                  requests: { cpu: "250m", memory: "512Mi" },
                },
              },
            ],
            volumes: [{ name: "dynamic-config", configMap: { name: DYNAMIC_CONFIG_MAP_NAME } }],
          },
        },
      },
    },
    { ...inNamespace, dependsOn: [schemaJob, dynamicConfig] },
  );

  const serverService = new k8s.core.v1.Service(
    "temporal-server",
    {
      metadata: {
        name: TEMPORAL_FRONTEND_SERVICE,
        namespace: namespaceName,
        labels: serverLabels,
      },
      spec: {
        type: "ClusterIP",
        selector: serverLabels,
        ports: [
          { name: "grpc", port: FRONTEND_GRPC_PORT, targetPort: FRONTEND_GRPC_PORT },
          { name: "http", port: FRONTEND_HTTP_PORT, targetPort: FRONTEND_HTTP_PORT },
        ],
      },
    },
    inNamespace,
  );

  // Named for the namespace it registers, not the version: re-running it is
  // only needed when THAT changes.
  const namespaceJobName = `temporal-namespace-${TEMPORAL_CLUSTER_NAMESPACE}`;
  const namespaceJob = new k8s.batch.v1.Job(
    namespaceJobName,
    {
      metadata: { name: namespaceJobName, namespace: namespaceName },
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
                image: ADMIN_TOOLS_IMAGE,
                command: ["/bin/sh", "-c", namespaceSetupScript()],
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
    { ...inNamespace, dependsOn: [server, serverService] },
  );

  const ui = new k8s.apps.v1.Deployment(
    "temporal-ui",
    {
      metadata: { name: "temporal-ui", namespace: namespaceName, labels: uiLabels },
      spec: {
        replicas: 1,
        selector: { matchLabels: uiLabels },
        template: {
          metadata: { labels: uiLabels },
          spec: {
            automountServiceAccountToken: false,
            containers: [
              {
                name: "temporal-ui",
                image: UI_IMAGE,
                env: [
                  {
                    name: "TEMPORAL_ADDRESS",
                    value: `${TEMPORAL_FRONTEND_SERVICE}:${FRONTEND_GRPC_PORT}`,
                  },
                  { name: "TEMPORAL_UI_PORT", value: String(UI_PORT) },
                  { name: "TEMPORAL_DEFAULT_NAMESPACE", value: TEMPORAL_CLUSTER_NAMESPACE },
                  // Reached by `kubectl port-forward`, so the browser's origin
                  // is localhost, not the Service name.
                  { name: "TEMPORAL_CORS_ORIGINS", value: `http://localhost:${UI_PORT}` },
                ],
                ports: [{ name: "http", containerPort: UI_PORT }],
                resources: {
                  limits: { memory: "256Mi" },
                  requests: { cpu: "50m", memory: "128Mi" },
                },
              },
            ],
          },
        },
      },
    },
    { ...inNamespace, dependsOn: [serverService] },
  );

  const uiService = new k8s.core.v1.Service(
    "temporal-ui",
    {
      metadata: { name: "temporal-ui", namespace: namespaceName, labels: uiLabels },
      spec: {
        type: "ClusterIP",
        selector: uiLabels,
        ports: [{ name: "http", port: UI_PORT, targetPort: UI_PORT }],
      },
    },
    inNamespace,
  );

  const worker = new k8s.apps.v1.Deployment(
    "temporal-worker",
    {
      metadata: { name: "temporal-worker", namespace: namespaceName, labels: workerLabels },
      spec: {
        // Two, so a rolling deploy never leaves the `main` task queue unpolled.
        replicas: 2,
        selector: { matchLabels: workerLabels },
        template: {
          metadata: { labels: workerLabels },
          spec: {
            automountServiceAccountToken: false,
            imagePullSecrets: [{ name: GHCR_PULL_SECRET_NAME }],
            containers: [
              {
                name: "temporal-worker",
                image: ghcrImage("temporal-worker", imageDigests),
                // No env: every knob (address, namespace, task queue, N) has an
                // in-cluster default in the env manifest. Overrides belong here
                // when they stop matching, not a duplicated copy of the defaults.
                resources: {
                  limits: { memory: "512Mi" },
                  requests: { cpu: "100m", memory: "256Mi" },
                },
              },
            ],
          },
        },
      },
    },
    { ...inNamespace, dependsOn: [namespaceJob] },
  );

  return {
    namespace,
    ghcrPullSecret,
    cluster,
    dynamicConfig,
    schemaJob,
    server,
    serverService,
    namespaceJob,
    ui,
    uiService,
    worker,
  };
}
