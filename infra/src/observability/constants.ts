/**
 * Shared constants for the observability stack (#33, ADR #207).
 *
 * The stack is hand-rolled: no Helm, no prometheus-operator, no CRDs. That is a
 * deliberate call (#207) — dropping the operator is what makes hand-rolling
 * cheap, since kube-prometheus-stack is mostly CRDs, a controller, alert rules
 * and multi-node assumptions this single-node cluster does not need.
 */

/**
 * Everything lives in one namespace, labelled Pod Security `privileged` because
 * node-exporter needs hostPath/hostPID/hostNetwork and Talos enforces
 * `baseline` on every namespace except kube-system. Splitting node-exporter
 * into its own privileged namespace and leaving the rest `baseline` is the
 * tighter arrangement and a worthwhile follow-up; it is not done here.
 */
export const OBSERVABILITY_NAMESPACE = "observability";

/**
 * `global.external_labels.cluster`. The kubernetes-mixin rules and every
 * standard Grafana dashboard template on a `cluster` label; without it the
 * dashboard variables render blank on a single-cluster install.
 */
export const CLUSTER_LABEL = "home-server";

export const PROMETHEUS_PORT = 9090;
export const GRAFANA_PORT = 3000;
export const LOKI_PORT = 3100;
export const NODE_EXPORTER_PORT = 9100;
export const KUBE_STATE_METRICS_PORT = 8080;

/**
 * Datasource UIDs are hand-chosen and STABLE. Dashboard JSON references
 * datasources by UID, so letting Grafana generate them is what makes
 * checked-in dashboards break on reinstall. Changing these breaks every
 * vendored dashboard.
 */
export const PROMETHEUS_DATASOURCE_UID = "www-prometheus";
export const LOKI_DATASOURCE_UID = "www-loki";

/** Bounded by the PVC size in prometheus.ts — an unbounded TSDB fills the node's root disk. */
export const PROMETHEUS_RETENTION = "15d";
/** 14 days, in hours (Loki's `limits_config.retention_period` wants a duration). */
export const LOKI_RETENTION_HOURS = 336;

// Images, pinned by tag and verified to exist on the registry 2026-07-26.
export const PROMETHEUS_IMAGE = "prom/prometheus:v3.13.1";
export const NODE_EXPORTER_IMAGE = "prom/node-exporter:v1.12.1";
export const KUBE_STATE_METRICS_IMAGE =
  "registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.19.1";
export const GRAFANA_IMAGE = "grafana/grafana:13.1.1";
export const LOKI_IMAGE = "grafana/loki:3.7.4";
export const ALLOY_IMAGE = "grafana/alloy:v1.18.0";
