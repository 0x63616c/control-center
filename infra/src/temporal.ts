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
//   6. `temporal-otel-collector` (#233), a small OTLP-in/Prometheus-out relay
//      for `temporal-worker`'s SDK-internal metrics — the worker's own
//      Runtime.install({ telemetryOptions }) speaks OTLP to it, and it
//      re-exports to the existing generic annotation-based scrape job. This
//      is separate from `temporal-worker`'s app-level @www/platform/metrics
//      listener and from `temporal-server`'s own Prometheus reporter above.
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
import { controlCenterProductManifest } from "@www/platform";
import { DEFAULT_METRICS_PORT } from "@www/platform/metrics/port";
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
// Where the server's Prometheus reporter listens. 9090 is Temporal's own
// documented convention for this listener and collides with neither frontend
// port; it is a per-pod listener, so sharing the number with the Prometheus
// server's own port in another namespace costs nothing.
const METRICS_PORT = 9090;
const METRICS_PATH = "/metrics";

// Image pins. `server` and `admin-tools` MUST move together: the schema the Job
// installs is the schema the server expects.
const TEMPORAL_VERSION = "1.31.2";
const SERVER_IMAGE = `temporalio/server:${TEMPORAL_VERSION}`;
const ADMIN_TOOLS_IMAGE = `temporalio/admin-tools:${TEMPORAL_VERSION}`;
const UI_IMAGE = "temporalio/ui:2.52.1";

// The OTel collector `temporal-worker`'s SDK-internal metrics (#233) go
// through: Runtime.install({ telemetryOptions: { metrics: { otel } } })
// speaks OTLP/gRPC to this pod, which re-exports to its own Prometheus
// exposition port for the existing generic `kubernetes-pods` scrape job to
// pick up — see infra/src/observability/scrape-config.ts, which already
// discovers any annotated pod in any namespace, so no dedicated scrape job is
// added for this. `-contrib` (not the core distribution) because the
// Prometheus exporter component ships only in contrib.
const OTEL_COLLECTOR_IMAGE = "otel/opentelemetry-collector-contrib:0.157.0";
const OTEL_COLLECTOR_OTLP_GRPC_PORT = 4317;
// Where the collector's OWN Prometheus exporter listens — distinct from
// METRICS_PORT (the Temporal server's reporter) and DEFAULT_METRICS_PORT (the
// worker's app-level @www/platform/metrics listener). 9464 is the
// OpenTelemetry Prometheus exporter's conventional default, same rationale as
// packages/platform/metrics/port.ts's DEFAULT_METRICS_PORT.
const OTEL_COLLECTOR_PROMETHEUS_PORT = 9464;
const OTEL_COLLECTOR_CONFIG_MAP_NAME = "temporal-otel-collector-config";
const OTEL_COLLECTOR_CONFIG_MOUNT = "/etc/otelcol";
const OTEL_COLLECTOR_CONFIG_FILE = `${OTEL_COLLECTOR_CONFIG_MOUNT}/config.yaml`;

/**
 * A single OTLP-in, Prometheus-out pipeline — nothing else. `resource`
 * processor is skipped: the worker's Runtime.install `attachServiceName`
 * default already stamps `service_name`, and this collector serves exactly
 * one client so there is nothing to disambiguate.
 */
function otelCollectorConfigYaml(): string {
  return [
    "receivers:",
    "  otlp:",
    "    protocols:",
    "      grpc:",
    `        endpoint: 0.0.0.0:${OTEL_COLLECTOR_OTLP_GRPC_PORT}`,
    "exporters:",
    "  prometheus:",
    `    endpoint: 0.0.0.0:${OTEL_COLLECTOR_PROMETHEUS_PORT}`,
    // Default true: otelcol appends unit/type suffixes (`_milliseconds`,
    // `_total`) that don't match the vendored SDK dashboard's PromQL, which
    // expects raw Temporal SDK metric names (e.g. `..._latency_bucket`, not
    // `..._latency_milliseconds_bucket`). Off so names match exactly.
    "    add_metric_suffixes: false",
    "service:",
    "  pipelines:",
    "    metrics:",
    "      receivers: [otlp]",
    "      exporters: [prometheus]",
    "",
  ].join("\n");
}

// Postgres. `postgres12` is Temporal's plugin name for "PostgreSQL 12 or
// newer", not a pin to 12 — CNPG runs 17.
const DB_PLUGIN = "postgres12";
const CNPG_CLUSTER_NAME = "temporal-postgres";
export const CNPG_RW_SERVICE_NAME = `${CNPG_CLUSTER_NAME}-rw`;
// CNPG mints this Secret itself from bootstrap.initdb (keys: username,
// password, …) for the `temporal` app owner — the server and schema Jobs use
// it, untouched. Nothing outside the cluster ever needs THIS credential.
const CNPG_APP_SECRET_NAME = `${CNPG_CLUSTER_NAME}-app`;
// A second, vault-sourced credential for the `postgres` superuser, same
// simplified bridge cnpg.ts/homeassistant.ts use elsewhere (one basic-auth
// Secret, enableSuperuserAccess:true, CNPG keeps its password reconciled to
// this Secret continuously). Exists ONLY so a human (via db-ui/pgAdmin) has a
// durable, known credential to browse this database with — the `temporal` app
// owner's self-minted password above is deliberately left alone.
export const CNPG_AUTH_SECRET_NAME = `${CNPG_CLUSTER_NAME}-auth`;
const SUPERUSER = "postgres";
export const DATABASE_OWNER = "temporal";
export const DATABASE_NAME = "temporal";
export const VISIBILITY_DATABASE_NAME = "temporal_visibility";
export const DATABASE_PORT = "5432";

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
// history is queryable. Set to 10 years per explicit request (issue #157) —
// long-term workflow history over storage economy.
const NAMESPACE_RETENTION = "87600h";

export interface TemporalArgs {
  provider: k8s.Provider;
  // The already-installed CNPG operator (cnpg.ts's installCnpg().operator): its
  // CRDs/webhooks are cluster-scoped singletons shared by every CNPG Cluster.
  cnpgOperator: k8s.yaml.ConfigFile;
  // Decrypted vault (vault.ts) — the GHCR pull token (temporal-worker's image
  // is private) and TEMPORAL_POSTGRES__PASSWORD (the `postgres` superuser
  // credential, see CNPG_AUTH_SECRET_NAME). The `temporal` app owner's
  // credential is still minted by CNPG in-cluster (see CNPG_APP_SECRET_NAME),
  // untouched by this vault key.
  vault: Record<string, string>;
  // Per-service GHCR digest pins from CI, for the temporal-worker image.
  imageDigests: ImageDigests;
}

export interface TemporalResources {
  namespace: k8s.core.v1.Namespace;
  ghcrPullSecret: k8s.core.v1.Secret;
  authSecret: k8s.core.v1.Secret;
  workerSecret: k8s.core.v1.Secret;
  cluster: k8s.apiextensions.CustomResource;
  dynamicConfig: k8s.core.v1.ConfigMap;
  schemaJob: k8s.batch.v1.Job;
  server: k8s.apps.v1.Deployment;
  serverService: k8s.core.v1.Service;
  namespaceJob: k8s.batch.v1.Job;
  ui: k8s.apps.v1.Deployment;
  uiService: k8s.core.v1.Service;
  worker: k8s.apps.v1.Deployment;
  otelCollectorConfig: k8s.core.v1.ConfigMap;
  otelCollector: k8s.apps.v1.Deployment;
  otelCollectorService: k8s.core.v1.Service;
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
    // Turns on global.metrics.prometheus in the image's config template, which
    // renders it as `listenAddress` verbatim — hence 0.0.0.0 and not localhost,
    // or the listener would be unreachable from outside the container. The
    // template's chain is `if STATSD_ENDPOINT / else if PROMETHEUS_ENDPOINT`,
    // so setting STATSD_ENDPOINT here would silently disable all of this.
    { name: "PROMETHEUS_ENDPOINT", value: `0.0.0.0:${METRICS_PORT}` },
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
 * `namespace update` runs unconditionally after, so a retention change to an
 * already-existing namespace still takes effect on redeploy.
 */
function namespaceSetupScript(): string {
  const address = `${TEMPORAL_FRONTEND_SERVICE}:${FRONTEND_GRPC_PORT}`;
  return [
    "set -eu",
    `export TEMPORAL_ADDRESS=${address}`,
    'echo "waiting for temporal frontend…"',
    "until temporal operator cluster health >/dev/null 2>&1; do sleep 2; done",
    `temporal operator namespace create --namespace ${TEMPORAL_CLUSTER_NAMESPACE} --retention ${NAMESPACE_RETENTION} || true`,
    `temporal operator namespace update --namespace ${TEMPORAL_CLUSTER_NAMESPACE} --retention ${NAMESPACE_RETENTION}`,
    `temporal operator namespace describe --namespace ${TEMPORAL_CLUSTER_NAMESPACE}`,
  ].join("\n");
}

function createAuthSecret(
  vault: Record<string, string>,
  namespace: pulumi.Input<string>,
  opts: pulumi.CustomResourceOptions,
): k8s.core.v1.Secret {
  const password = vault.TEMPORAL_POSTGRES__PASSWORD;
  if (password === undefined) {
    throw new Error("temporal: vault key TEMPORAL_POSTGRES__PASSWORD not found");
  }
  return new k8s.core.v1.Secret(
    CNPG_AUTH_SECRET_NAME,
    {
      metadata: { name: CNPG_AUTH_SECRET_NAME, namespace },
      type: "kubernetes.io/basic-auth",
      stringData: { username: SUPERUSER, password: pulumi.secret(password) },
    },
    opts,
  );
}

/**
 * The temporal-worker's app-secret (ADR-0008): the control-center Postgres
 * password, mounted at /run/secrets/POSTGRES_PASSWORD exactly like the api and
 * worker pods, so the worker's boot-env derives DATABASE_URL for db-touching
 * activities (e.g. the weather purge). Created here — not in eso.ts — because
 * that module's targets are typed to the product namespaces and everything in
 * the `temporal` k8s namespace is owned by this file.
 */
const WORKER_SECRET_NAME = "temporal-worker-secrets";

function createWorkerSecret(
  vault: Record<string, string>,
  namespace: pulumi.Input<string>,
  opts: pulumi.CustomResourceOptions,
): k8s.core.v1.Secret {
  const password = vault.CONTROL_CENTER_POSTGRES__PASSWORD;
  if (password === undefined) {
    throw new Error("temporal: vault key CONTROL_CENTER_POSTGRES__PASSWORD not found");
  }
  return new k8s.core.v1.Secret(
    WORKER_SECRET_NAME,
    {
      metadata: { name: WORKER_SECRET_NAME, namespace },
      stringData: { POSTGRES_PASSWORD: pulumi.secret(password) },
    },
    opts,
  );
}

const serverLabels = { app: TEMPORAL_FRONTEND_SERVICE };
const uiLabels = { app: "temporal-ui" };
const workerLabels = { app: "temporal-worker" };
const otelCollectorLabels = { app: "temporal-otel-collector" };

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

  const authSecret = createAuthSecret(vault, namespaceName, {
    ...inNamespace,
    dependsOn: [namespace],
  });

  const workerSecret = createWorkerSecret(vault, namespaceName, {
    ...inNamespace,
    dependsOn: [namespace],
  });

  const cluster = new k8s.apiextensions.CustomResource(
    CNPG_CLUSTER_NAME,
    {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: { name: CNPG_CLUSTER_NAME, namespace: namespaceName },
      spec: {
        instances: 1,
        // `postgres` superuser access, keyed to a vault-sourced Secret CNPG
        // reconciles continuously — same bridge cnpg.ts/homeassistant.ts use.
        // Purely additive: the `temporal` app owner below is untouched, still
        // self-minted into CNPG_APP_SECRET_NAME, still what the server/schema
        // Jobs use.
        enableSuperuserAccess: true,
        superuserSecret: { name: CNPG_AUTH_SECRET_NAME },
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
        storage: { storageClass: "local-lvm", size: "10Gi" },
        resources: {
          limits: { memory: "1Gi" },
          requests: { cpu: "250m", memory: "512Mi" },
        },
      },
    },
    { ...inNamespace, dependsOn: [namespace, cnpgOperator, authSecret] },
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
          metadata: {
            labels: serverLabels,
            // On the POD template, not the Deployment: annotation-based scrape
            // discovery reads pod annotations, and it is pods we want scraped
            // individually. Both replicas run all four roles, so each carries
            // its own history/matching/frontend series — scraping through the
            // Service would land on an arbitrary one of the two and silently
            // lose half the cluster's metrics.
            annotations: {
              "prometheus.io/scrape": "true",
              "prometheus.io/port": String(METRICS_PORT),
              "prometheus.io/path": METRICS_PATH,
            },
          },
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
                  { name: "metrics", containerPort: METRICS_PORT },
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
          // Present so the port is addressable by name and visible in `kubectl
          // get svc`; the actual scrape goes pod-by-pod (see the pod
          // annotations), because this Service would balance across replicas.
          { name: "metrics", port: METRICS_PORT, targetPort: METRICS_PORT },
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
                  // Two browser origins, both real: the Cloudflare tunnel host
                  // (the normal way in) and localhost for `kubectl
                  // port-forward` (the way in when the tunnel or Access is the
                  // thing being debugged). Never the Service name — no browser
                  // ever sees that as an origin.
                  {
                    name: "TEMPORAL_CORS_ORIGINS",
                    value: [
                      `https://${controlCenterProductManifest().temporalUi.exposure.hostname}`,
                      `http://localhost:${UI_PORT}`,
                    ].join(","),
                  },
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
        // Single replica: worker has no listener to keep up during a
        // rolling deploy, so redundancy doesn't buy anything here.
        replicas: 1,
        selector: { matchLabels: workerLabels },
        template: {
          metadata: {
            labels: workerLabels,
            // Prometheus scrape target (#214). On the POD TEMPLATE, not the
            // Deployment: `role: pod` service discovery only ever sees Pods.
            // This Deployment is hand-written (it lives in the `temporal`
            // namespace, not the control-center WorkloadSpec set), so the
            // annotations are spelled out here rather than coming from
            // `WorkloadSpec.scrape`. The PORT is our own app-level exposition
            // port (`DEFAULT_METRICS_PORT`, shared with the listener the worker
            // starts), NOT the `METRICS_PORT` above — that one is the upstream
            // Temporal server's own reporter. No Service fronts it: in-cluster
            // scraping only.
            annotations: {
              "prometheus.io/scrape": "true",
              "prometheus.io/port": String(DEFAULT_METRICS_PORT),
              "prometheus.io/path": METRICS_PATH,
            },
          },
          spec: {
            automountServiceAccountToken: false,
            imagePullSecrets: [{ name: GHCR_PULL_SECRET_NAME }],
            containers: [
              {
                name: "temporal-worker",
                image: ghcrImage("temporal-worker", imageDigests),
                // Every Temporal knob (address, namespace, task queue) has an
                // in-cluster default in the env manifest; overrides belong
                // here only when they stop matching. APP_ENV is not one of
                // those knobs — @www/logger reads it LIVE (never NODE_ENV,
                // which bundlers bake in) and falls back to "development", so
                // without it every prod log line from this worker is stamped
                // with the wrong environment. POSTGRES_HOST is the
                // cross-namespace FQDN of the control-center database's rw
                // Service: db-touching activities (ADR-0008) derive
                // DATABASE_URL from it plus the mounted POSTGRES_PASSWORD,
                // exactly like the api/worker pods do in their own namespace.
                env: [
                  { name: "APP_ENV", value: "production" },
                  {
                    name: "POSTGRES_HOST",
                    value: `${controlCenterProductManifest().database.rwServiceName}.control-center.svc.cluster.local`,
                  },
                ],
                volumeMounts: [{ name: "secrets", mountPath: "/run/secrets", readOnly: true }],
                resources: {
                  limits: { memory: "512Mi" },
                  requests: { cpu: "100m", memory: "256Mi" },
                },
              },
            ],
            volumes: [{ name: "secrets", secret: { secretName: WORKER_SECRET_NAME } }],
          },
        },
      },
    },
    { ...inNamespace, dependsOn: [namespaceJob, workerSecret] },
  );

  const otelCollectorConfig = new k8s.core.v1.ConfigMap(
    OTEL_COLLECTOR_CONFIG_MAP_NAME,
    {
      metadata: { name: OTEL_COLLECTOR_CONFIG_MAP_NAME, namespace: namespaceName },
      data: { "config.yaml": otelCollectorConfigYaml() },
    },
    inNamespace,
  );

  const otelCollector = new k8s.apps.v1.Deployment(
    "temporal-otel-collector",
    {
      metadata: {
        name: "temporal-otel-collector",
        namespace: namespaceName,
        labels: otelCollectorLabels,
      },
      spec: {
        // Single replica: this collector holds no state across restarts worth
        // preserving, and the worker's OTLP export is fire-and-forget.
        replicas: 1,
        selector: { matchLabels: otelCollectorLabels },
        template: {
          metadata: {
            labels: otelCollectorLabels,
            // On the POD template, same reasoning as the worker's own
            // annotations above: `role: pod` discovery only ever sees Pods.
            // This is the collector's OWN Prometheus-exporter port — not
            // METRICS_PORT (server) and not DEFAULT_METRICS_PORT (worker
            // app-level metrics) — so the existing generic `kubernetes-pods`
            // job picks it up with no dedicated scrape job of its own.
            annotations: {
              "prometheus.io/scrape": "true",
              "prometheus.io/port": String(OTEL_COLLECTOR_PROMETHEUS_PORT),
              "prometheus.io/path": METRICS_PATH,
            },
          },
          spec: {
            automountServiceAccountToken: false,
            containers: [
              {
                name: "otel-collector",
                image: OTEL_COLLECTOR_IMAGE,
                args: [`--config=${OTEL_COLLECTOR_CONFIG_FILE}`],
                ports: [
                  { name: "otlp-grpc", containerPort: OTEL_COLLECTOR_OTLP_GRPC_PORT },
                  { name: "metrics", containerPort: OTEL_COLLECTOR_PROMETHEUS_PORT },
                ],
                volumeMounts: [{ name: "config", mountPath: OTEL_COLLECTOR_CONFIG_MOUNT }],
                resources: {
                  limits: { memory: "256Mi" },
                  requests: { cpu: "50m", memory: "128Mi" },
                },
              },
            ],
            volumes: [{ name: "config", configMap: { name: OTEL_COLLECTOR_CONFIG_MAP_NAME } }],
          },
        },
      },
    },
    { ...inNamespace, dependsOn: [otelCollectorConfig] },
  );

  const otelCollectorService = new k8s.core.v1.Service(
    "temporal-otel-collector",
    {
      metadata: {
        name: "temporal-otel-collector",
        namespace: namespaceName,
        labels: otelCollectorLabels,
      },
      spec: {
        type: "ClusterIP",
        selector: otelCollectorLabels,
        ports: [
          {
            name: "otlp-grpc",
            port: OTEL_COLLECTOR_OTLP_GRPC_PORT,
            targetPort: OTEL_COLLECTOR_OTLP_GRPC_PORT,
          },
        ],
      },
    },
    { ...inNamespace, dependsOn: [otelCollector] },
  );

  return {
    namespace,
    ghcrPullSecret,
    authSecret,
    workerSecret,
    cluster,
    dynamicConfig,
    schemaJob,
    server,
    serverService,
    namespaceJob,
    ui,
    uiService,
    worker,
    otelCollectorConfig,
    otelCollector,
    otelCollectorService,
  };
}
