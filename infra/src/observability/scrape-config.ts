// Prometheus's `prometheus.yml`, built as a plain object and serialised with
// the `yaml` package (already an infra dependency). Hand-concatenating this
// file as a template string is how indentation bugs get shipped: a scrape job
// that silently lands one level too deep is still valid YAML, just not the
// config anyone intended.
//
// JOB NAMES ARE LOAD-BEARING. The vendored kubernetes-mixin recording rules
// select on `job="kubelet"`, `job="cadvisor"`, `job="kube-state-metrics"` and
// `job="node-exporter"` literally. Renaming a job here does not break the
// scrape — it silently empties every mixin-derived dashboard panel.

import { stringify } from "yaml";
import {
  CLUSTER_LABEL,
  NODE_EXPORTER_PORT,
  OBSERVABILITY_NAMESPACE,
  PROMETHEUS_PORT,
} from "./constants.ts";

/**
 * A relabel/metric_relabel rule. Prometheus's own schema is looser than this
 * (every field optional), and that looseness is the point: a typo'd
 * `source_label` is a config Prometheus rejects at boot, so we keep the field
 * names in one place rather than spelling them per-job.
 */
type RelabelConfig = {
  source_labels?: string[];
  separator?: string;
  target_label?: string;
  regex?: string;
  replacement?: string;
  action?: "replace" | "keep" | "drop" | "labelmap" | "labeldrop" | "labelkeep";
};

type ScrapeConfig = {
  job_name: string;
  scheme?: "http" | "https";
  metrics_path?: string;
  bearer_token_file?: string;
  tls_config?: { insecure_skip_verify: boolean };
  static_configs?: { targets: string[] }[];
  kubernetes_sd_configs?: { role: "node" | "pod" | "endpoints" | "service" }[];
  relabel_configs?: RelabelConfig[];
};

type PrometheusConfig = {
  global: {
    scrape_interval: string;
    evaluation_interval: string;
    external_labels: Record<string, string>;
  };
  rule_files: string[];
  scrape_configs: ScrapeConfig[];
};

/** Where the orchestrator mounts the vendored kubernetes-mixin recording rules. */
export const PROMETHEUS_RULES_DIR = "/etc/prometheus/rules";
/** Path the config ConfigMap is mounted at inside the container. */
export const PROMETHEUS_CONFIG_DIR = "/etc/prometheus";
export const PROMETHEUS_CONFIG_FILE = `${PROMETHEUS_CONFIG_DIR}/prometheus.yml`;
/** TSDB lives on the PVC; the image's default (/prometheus) is an emptyDir otherwise. */
export const PROMETHEUS_DATA_DIR = "/prometheus";

// The ServiceAccount token every in-cluster scrape authenticates with. Talos's
// kubelet serving cert is self-signed, so TLS verification has to be skipped
// (the same reason metrics-server already runs with --kubelet-insecure-tls).
const SA_TOKEN_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const KUBELET_PORT = 10250;

/**
 * kubelet and cadvisor are the same discovery and the same endpoint, differing
 * only in `__metrics_path__`, so they share one builder.
 */
function kubeletJob(jobName: string, metricsPath: string): ScrapeConfig {
  return {
    job_name: jobName,
    scheme: "https",
    bearer_token_file: SA_TOKEN_FILE,
    tls_config: { insecure_skip_verify: true },
    kubernetes_sd_configs: [{ role: "node" }],
    relabel_configs: [
      // Node labels (topology.kubernetes.io/*, kubernetes.io/os, …) carried
      // onto the series — several mixin dashboards group by them.
      { action: "labelmap", regex: "__meta_kubernetes_node_label_(.+)" },
      { source_labels: ["__meta_kubernetes_node_name"], target_label: "node" },
      // role:node's default __address__ is the kubelet's *API-advertised*
      // address; pin it to the InternalIP:10250 so a node with a hostname the
      // cluster DNS cannot resolve still scrapes.
      {
        source_labels: ["__meta_kubernetes_node_address_InternalIP"],
        target_label: "__address__",
        replacement: `$1:${KUBELET_PORT}`,
      },
      { target_label: "__metrics_path__", replacement: metricsPath },
    ],
  };
}

function buildScrapeConfigs(): ScrapeConfig[] {
  return [
    {
      job_name: "prometheus",
      static_configs: [{ targets: [`localhost:${PROMETHEUS_PORT}`] }],
    },

    kubeletJob("kubelet", "/metrics"),
    // NOT "kubernetes-cadvisor": the mixin's container-level rules select
    // job="cadvisor" exactly.
    kubeletJob("cadvisor", "/metrics/cadvisor"),

    {
      // Endpoint SD rather than a static target, because the Service exposes
      // TWO ports: `http-metrics` (the cluster-state series the mixin rules
      // read) and `telemetry` (kube-state-metrics' own self-metrics). A static
      // target cannot express "only that port", and scraping both would give
      // job="kube-state-metrics" two disjoint series sets from one job.
      job_name: "kube-state-metrics",
      kubernetes_sd_configs: [{ role: "endpoints" }],
      relabel_configs: [
        {
          source_labels: [
            "__meta_kubernetes_namespace",
            "__meta_kubernetes_service_name",
            "__meta_kubernetes_endpoint_port_name",
          ],
          action: "keep",
          regex: `${OBSERVABILITY_NAMESPACE};kube-state-metrics;http-metrics`,
        },
        { source_labels: ["__meta_kubernetes_pod_name"], target_label: "pod" },
      ],
    },

    {
      job_name: "node-exporter",
      kubernetes_sd_configs: [{ role: "pod" }],
      relabel_configs: [
        // Pod SD, not endpoint SD: the DaemonSet's pod carries
        // `__meta_kubernetes_pod_node_name`, which is the label the mixin
        // joins on (see below). The selector label is the one the DaemonSet
        // actually sets — `app.kubernetes.io/name`, not a bare `app`.
        {
          source_labels: [
            "__meta_kubernetes_namespace",
            "__meta_kubernetes_pod_label_app_kubernetes_io_name",
          ],
          action: "keep",
          regex: `${OBSERVABILITY_NAMESPACE};node-exporter`,
        },
        // hostNetwork DaemonSet, so the pod IP *is* the node IP; pinning the
        // port keeps the target correct even if the pod declares extra ports.
        {
          source_labels: ["__meta_kubernetes_pod_ip"],
          target_label: "__address__",
          replacement: `$1:${NODE_EXPORTER_PORT}`,
        },
        // The mixin's node.rules join node-exporter series to kube-state-metrics
        // series on `instance`, and expect it to be the NODE NAME. Left at the
        // default (the scraped address) the joins produce nothing.
        { source_labels: ["__meta_kubernetes_pod_node_name"], target_label: "instance" },
        { source_labels: ["__meta_kubernetes_pod_node_name"], target_label: "node" },
        { source_labels: ["__meta_kubernetes_pod_name"], target_label: "pod" },
        { source_labels: ["__meta_kubernetes_namespace"], target_label: "namespace" },
      ],
    },

    {
      // Every CNPG database in the cluster, with no per-cluster configuration:
      // the operator stamps the same three labels on every instance pod, so
      // adding a fourth database changes nothing here.
      job_name: "cnpg",
      kubernetes_sd_configs: [{ role: "pod" }],
      relabel_configs: [
        {
          source_labels: ["__meta_kubernetes_pod_label_cnpg_io_podRole"],
          action: "keep",
          regex: "instance",
        },
        // Instance pods expose 5432 as well; without this the 5432 target is
        // scraped too and fails on every cycle.
        {
          source_labels: ["__meta_kubernetes_pod_container_port_name"],
          action: "keep",
          regex: "metrics",
        },
        // `cluster_name`, NOT `cluster` — `cluster` is the global external
        // label, and overwriting it per-target breaks every mixin dashboard's
        // cluster variable.
        {
          source_labels: ["__meta_kubernetes_pod_label_cnpg_io_cluster"],
          target_label: "cluster_name",
        },
        {
          source_labels: ["__meta_kubernetes_pod_label_cnpg_io_instanceRole"],
          target_label: "role",
        },
        { source_labels: ["__meta_kubernetes_namespace"], target_label: "namespace" },
        { source_labels: ["__meta_kubernetes_pod_name"], target_label: "pod" },
      ],
    },

    {
      // Annotation-based discovery, verbatim from the current
      // prometheus-community/prometheus chart. This is the seam our own
      // workloads opt into with prometheus.io/scrape="true"; keeping the
      // upstream block means the annotations behave exactly as documented
      // everywhere else.
      job_name: "kubernetes-pods",
      kubernetes_sd_configs: [{ role: "pod" }],
      relabel_configs: [
        {
          source_labels: ["__meta_kubernetes_pod_annotation_prometheus_io_scrape"],
          action: "keep",
          regex: "true",
        },
        {
          source_labels: ["__meta_kubernetes_pod_annotation_prometheus_io_scheme"],
          action: "replace",
          regex: "(https?)",
          target_label: "__scheme__",
        },
        {
          source_labels: ["__meta_kubernetes_pod_annotation_prometheus_io_path"],
          action: "replace",
          regex: "(.+)",
          target_label: "__metrics_path__",
        },
        // Two address rules, IPv6 first: a bracketed [::1]:9090 literal and a
        // dotted 10.0.0.1:9090 literal cannot be matched by one regex, and a
        // single IPv4-shaped rule silently drops every dual-stack pod.
        {
          source_labels: [
            "__meta_kubernetes_pod_annotation_prometheus_io_port",
            "__meta_kubernetes_pod_ip",
          ],
          action: "replace",
          regex: "(\\d+);(([A-Fa-f0-9]{1,4}::?){1,7}[A-Fa-f0-9]{1,4})",
          replacement: "[$2]:$1",
          target_label: "__address__",
        },
        {
          source_labels: [
            "__meta_kubernetes_pod_annotation_prometheus_io_port",
            "__meta_kubernetes_pod_ip",
          ],
          action: "replace",
          regex: "(\\d+);((([0-9]+?)(\\.|$)){4})",
          replacement: "$2:$1",
          target_label: "__address__",
        },
        { action: "labelmap", regex: "__meta_kubernetes_pod_label_(.+)" },
        {
          source_labels: ["__meta_kubernetes_namespace"],
          action: "replace",
          target_label: "namespace",
        },
        {
          source_labels: ["__meta_kubernetes_pod_name"],
          action: "replace",
          target_label: "pod",
        },
        // A Completed Job's pod keeps its annotations forever; scraping it just
        // produces a permanently DOWN target.
        {
          source_labels: ["__meta_kubernetes_pod_phase"],
          action: "drop",
          regex: "Pending|Succeeded|Failed|Completed",
        },
      ],
    },

    // DELIBERATELY ABSENT: kube-scheduler, kube-controller-manager, kube-proxy
    // and etcd. On Talos they bind to 127.0.0.1 only, so any scrape job for
    // them sits permanently DOWN and drags the mixin's "cluster components"
    // panels red. Out of scope by decision — do not "fix" this by opening those
    // bind addresses in talconfig.yaml.
  ];
}

/** The full `prometheus.yml`, as YAML text, for the `prometheus-config` ConfigMap. */
export function buildPrometheusConfig(): string {
  const config: PrometheusConfig = {
    global: {
      scrape_interval: "30s",
      evaluation_interval: "30s",
      external_labels: { cluster: CLUSTER_LABEL },
    },
    rule_files: [`${PROMETHEUS_RULES_DIR}/*.yaml`],
    scrape_configs: buildScrapeConfigs(),
  };
  return stringify(config, { lineWidth: 0 });
}
