// Centralized log storage (#216). Loki 3.7 in SINGLE-BINARY (monolithic,
// `-target=all`) mode on the filesystem: one node, one disk, no object store.
// The microservices/SSD deployment modes exist to scale reads and writes
// independently across many machines, which is exactly the thing this cluster
// will never do; running them here would buy nothing but a dozen extra pods and
// a memberlist ring that has to agree with itself.

import { createHash } from "node:crypto";
import * as k8s from "@pulumi/kubernetes";
import * as yaml from "yaml";
import {
  LOKI_IMAGE,
  LOKI_PORT,
  LOKI_RETENTION_HOURS,
  OBSERVABILITY_NAMESPACE,
} from "./constants.ts";

/** Name of every Loki object (ConfigMap/PVC excepted) and of the Service the datasource points at. */
const LOKI_NAME = "loki";
const CONFIG_MAP_NAME = "loki-config";
const PVC_NAME = "loki-data";
const CONFIG_MOUNT_PATH = "/etc/loki";
const CONFIG_FILE_NAME = "config.yaml";

/**
 * `common.path_prefix`. Everything Loki writes — chunks, the TSDB index, the
 * WAL, the compactor's retention scratch space — hangs off this one directory,
 * which is the single PVC mount. Splitting them across mounts is what makes a
 * single-binary install lose data on restart.
 */
const DATA_PATH = "/loki";

/**
 * The gRPC port `-target=all` still opens for its internal ring/frontend
 * traffic. Nothing outside the pod talks to it, but it must not collide with
 * the HTTP port.
 */
const LOKI_GRPC_PORT = 9096;

/**
 * 30Gi on `local-lvm`, the node's only StorageClass. Node-local disk is
 * finite (~930 GiB total, shared with Prometheus, Postgres and Plex), so the
 * PVC is the hard ceiling and `retention_period` is what keeps usage below it.
 * Sized for 14 days of a handful of chatty backend services at pino `info`.
 */
const PVC_SIZE = "30Gi";

/**
 * The upstream `grafana/loki` image runs as uid/gid 10001, NOT root. A
 * `local-lvm` PV is created root-owned, so without `fsGroup` the container
 * cannot create `/loki/chunks` and crash-loops on boot with a permission
 * error that looks like a config problem. This single line is the difference
 * between "Loki works" and an afternoon of reading storage config.
 */
const LOKI_UID = 10001;

/**
 * The Loki config, as an object so it is diffable and testable rather than a
 * heredoc. Rendered to YAML into the ConfigMap.
 *
 * Version-sensitive bits, all deliberate:
 *  - `schema_config` uses the **tsdb** store at schema **v13**. boltdb-shipper
 *    and v11/v12 are legacy: they still parse in 3.x, but tsdb is the only
 *    index that supports the current query engine and structured metadata, and
 *    a schema migration later means running two schema periods forever. Start
 *    on the end state.
 *  - `auth_enabled: false` puts everything in the single `fake` tenant. There
 *    is one consumer (our Grafana) and no multi-tenancy story; turning it on
 *    would mean every push and query has to carry `X-Scope-OrgID`.
 */
function buildLokiConfig(): Record<string, unknown> {
  return {
    auth_enabled: false,

    server: {
      http_listen_port: LOKI_PORT,
      grpc_listen_port: LOKI_GRPC_PORT,
      // The upstream sample ships `debug`, which on a real workload writes more
      // lines about ingesting logs than there are logs.
      log_level: "info",
      // Loki's default 4MB gRPC message cap truncates large query responses in
      // the single-binary path (querier ↔ frontend still speak gRPC in-process).
      grpc_server_max_recv_msg_size: 33_554_432,
      grpc_server_max_send_msg_size: 33_554_432,
    },

    common: {
      path_prefix: DATA_PATH,
      // Single binary: the ring has exactly one member, so it advertises
      // loopback and lives in memory. An inmemory KV store means no consul/etcd
      // and no memberlist gossip to misconfigure.
      instance_addr: "127.0.0.1",
      replication_factor: 1,
      ring: { kvstore: { store: "inmemory" } },
      storage: {
        filesystem: {
          chunks_directory: `${DATA_PATH}/chunks`,
          rules_directory: `${DATA_PATH}/rules`,
        },
      },
    },

    schema_config: {
      configs: [
        {
          // A fresh install: one schema period, starting before any data
          // exists. The date is historical on purpose — a `from` in the future
          // leaves Loki with no active schema and it refuses every write.
          from: "2024-01-01",
          store: "tsdb",
          object_store: "filesystem",
          schema: "v13",
          index: { prefix: "index_", period: "24h" },
        },
      ],
    },

    /**
     * Retention is NOT self-executing. `limits_config.retention_period` alone
     * only makes queries stop returning old data — the chunks stay on disk
     * forever and the PVC fills up. The compactor is the component that
     * actually deletes them, and it does so only when `retention_enabled` is
     * true AND it has a `delete_request_store` to record deletes in.
     */
    compactor: {
      working_directory: `${DATA_PATH}/compactor`,
      retention_enabled: true,
      delete_request_store: "filesystem",
      compaction_interval: "10m",
      // Grace period between a chunk being marked for deletion and actually
      // going away, so an in-flight query does not read a vanished file.
      retention_delete_delay: "2h",
      retention_delete_worker_count: 50,
    },

    limits_config: {
      retention_period: `${LOKI_RETENTION_HOURS}h`,

      // Generous for a homelab, but bounded: an unlimited ingester turns one
      // crash-looping pod's stack traces into a full disk. These are ~10x
      // steady-state volume for this cluster.
      ingestion_rate_mb: 16,
      ingestion_burst_size_mb: 32,
      per_stream_rate_limit: "8MB",
      per_stream_rate_limit_burst: "16MB",
      max_streams_per_user: 10_000,
      max_line_size: "256KB",
      // Truncate rather than drop: a 300KB log line is a bug, but losing it
      // entirely hides the bug.
      max_line_size_truncate: true,

      // Reject anything older than a day rather than silently accepting it.
      // Out-of-order-by-a-week samples come from a clock-skewed or replaying
      // collector, and accepting them corrupts the index's time ordering.
      reject_old_samples: true,
      reject_old_samples_max_age: "24h",

      // Bound query blast radius so one `{namespace=~".+"}` cannot OOM the
      // single process that is also doing the ingesting.
      max_query_series: 5_000,
      max_query_parallelism: 16,
      // Must not exceed retention, or the UI offers ranges with no data.
      max_query_lookback: `${LOKI_RETENTION_HOURS}h`,

      // v13/tsdb only. Lets Alloy attach high-cardinality fields (request ids,
      // trace ids) as structured metadata instead of labels — see alloy.ts.
      allow_structured_metadata: true,
      volume_enabled: true,
    },

    query_range: {
      // In-process result cache. An external memcached is the scale-out
      // answer; at this size it would be another pod to keep alive.
      results_cache: { cache: { embedded_cache: { enabled: true, max_size_mb: 100 } } },
      align_queries_with_step: true,
    },

    // Replaying a large WAL on every restart is slow and, on a single replica,
    // pointless beyond crash recovery — flush aggressively instead.
    ingester: {
      chunk_idle_period: "1h",
      chunk_target_size: 1_572_864,
      max_chunk_age: "2h",
      wal: { enabled: true, dir: `${DATA_PATH}/wal` },
    },

    // No `ruler` block: alerting lives in Prometheus, and a ruler with no rule
    // storage configured logs an error on every evaluation cycle.
    analytics: { reporting_enabled: false },
  };
}

export type LokiArgs = {
  provider: k8s.Provider;
  namespace: k8s.core.v1.Namespace;
};

export type LokiResources = {
  config: k8s.core.v1.ConfigMap;
  pvc: k8s.core.v1.PersistentVolumeClaim;
  deployment: k8s.apps.v1.Deployment;
  /** Named `loki` — the Grafana datasource and Alloy's `loki.write` both address it by DNS. */
  service: k8s.core.v1.Service;
};

/**
 * @public — installs single-binary Loki into the observability namespace.
 * The Namespace is created by the caller (index.ts) and passed in.
 */
export function installLoki(args: LokiArgs): LokiResources {
  const { provider, namespace } = args;
  const options = { provider, dependsOn: [namespace] };
  const labels = { "app.kubernetes.io/name": LOKI_NAME };

  const configYaml = yaml.stringify(buildLokiConfig());

  const config = new k8s.core.v1.ConfigMap(
    CONFIG_MAP_NAME,
    {
      metadata: { name: CONFIG_MAP_NAME, namespace: OBSERVABILITY_NAMESPACE, labels },
      data: { [CONFIG_FILE_NAME]: configYaml },
    },
    options,
  );

  const pvc = new k8s.core.v1.PersistentVolumeClaim(
    PVC_NAME,
    {
      metadata: { name: PVC_NAME, namespace: OBSERVABILITY_NAMESPACE, labels },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: "local-lvm",
        resources: { requests: { storage: PVC_SIZE } },
      },
    },
    options,
  );

  const deployment = new k8s.apps.v1.Deployment(
    LOKI_NAME,
    {
      metadata: { name: LOKI_NAME, namespace: OBSERVABILITY_NAMESPACE, labels },
      spec: {
        replicas: 1,
        // Recreate, never RollingUpdate: the RWO PVC can only be mounted by one
        // pod, so a rolling update deadlocks with the new pod Pending on a
        // volume the old pod still holds.
        strategy: { type: "Recreate" },
        selector: { matchLabels: labels },
        template: {
          metadata: {
            labels,
            // Rolls the pod when the config changes. A ConfigMap-backed volume
            // updates in place and Loki does not watch its config file, so
            // without this a config edit applies silently at the next unrelated
            // restart — possibly weeks later.
            annotations: {
              "checksum/config": createHash("sha256").update(configYaml).digest("hex"),
            },
          },
          spec: {
            securityContext: {
              runAsUser: LOKI_UID,
              runAsGroup: LOKI_UID,
              // See LOKI_UID: without fsGroup the local-lvm volume stays
              // root-owned and Loki crash-loops.
              fsGroup: LOKI_UID,
            },
            containers: [
              {
                name: LOKI_NAME,
                image: LOKI_IMAGE,
                args: [
                  `-config.file=${CONFIG_MOUNT_PATH}/${CONFIG_FILE_NAME}`,
                  // Monolithic mode: every Loki component in one process.
                  "-target=all",
                ],
                ports: [
                  { name: "http", containerPort: LOKI_PORT },
                  { name: "grpc", containerPort: LOKI_GRPC_PORT },
                ],
                readinessProbe: {
                  httpGet: { path: "/ready", port: "http" },
                  // /ready stays 503 for ~15s after boot while the ingester
                  // joins its own ring; probing earlier just logs noise.
                  initialDelaySeconds: 20,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: "/ready", port: "http" },
                  initialDelaySeconds: 60,
                  periodSeconds: 30,
                  failureThreshold: 6,
                },
                // No cpu limit anywhere in this repo: throttling a compaction
                // run makes it take longer, it does not make it cheaper.
                resources: {
                  requests: { cpu: "100m", memory: "512Mi" },
                  limits: { memory: "2Gi" },
                },
                volumeMounts: [
                  { name: "config", mountPath: CONFIG_MOUNT_PATH },
                  { name: "data", mountPath: DATA_PATH },
                ],
              },
            ],
            volumes: [
              { name: "config", configMap: { name: CONFIG_MAP_NAME } },
              { name: "data", persistentVolumeClaim: { claimName: PVC_NAME } },
            ],
          },
        },
      },
    },
    { ...options, dependsOn: [namespace, config, pvc] },
  );

  const service = new k8s.core.v1.Service(
    LOKI_NAME,
    {
      metadata: { name: LOKI_NAME, namespace: OBSERVABILITY_NAMESPACE, labels },
      spec: {
        type: "ClusterIP",
        selector: labels,
        ports: [{ name: "http", port: LOKI_PORT, targetPort: "http" }],
      },
    },
    options,
  );

  return { config, pvc, deployment, service };
}
