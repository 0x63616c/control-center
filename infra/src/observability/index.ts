import * as k8s from "@pulumi/kubernetes";
import { installAlloy } from "./alloy.ts";
import { OBSERVABILITY_NAMESPACE } from "./constants.ts";
import { installDashboardConfigMaps } from "./dashboards.ts";
import { installGrafana } from "./grafana.ts";
import { installKubeStateMetrics } from "./kube-state-metrics.ts";
import { installLoki } from "./loki.ts";
import { installNodeExporter } from "./node-exporter.ts";
import { installPrometheus } from "./prometheus.ts";
import { installObservabilityRules } from "./rules.ts";

export * from "./constants.ts";

export type ObservabilityArgs = {
  provider: k8s.Provider;
};

export type ObservabilityResources = {
  namespace: k8s.core.v1.Namespace;
  rulesConfigMap: k8s.core.v1.ConfigMap;
  prometheus: ReturnType<typeof installPrometheus>;
  nodeExporter: ReturnType<typeof installNodeExporter>;
  kubeStateMetrics: ReturnType<typeof installKubeStateMetrics>;
  loki: ReturnType<typeof installLoki>;
  alloy: ReturnType<typeof installAlloy>;
  grafana: ReturnType<typeof installGrafana>;
};

/**
 * The observability stack (#33): Prometheus + node-exporter + kube-state-metrics
 * for metrics, Loki + Alloy for logs, Grafana as the single surface — reached
 * only through the Cloudflare tunnel at grafana.worldwidewebb.co.
 *
 * Hand-written resources throughout: no Helm, no prometheus-operator, no CRDs
 * (ADR #207). Scrape targets are discovered from `prometheus.io/*` pod
 * annotations rather than ServiceMonitor CRDs, which keeps each workload's
 * monitoring declared next to the workload (ADR-0001) with no central list.
 *
 * Talos constrains two things worth knowing before changing anything here:
 * kube-scheduler, kube-controller-manager, kube-proxy and etcd all bind to
 * 127.0.0.1, so they are deliberately NOT scraped (their targets would sit
 * permanently DOWN); and the kubelet's serving cert is self-signed, so scrapes
 * skip TLS verification — the same reason metrics-server runs
 * `--kubelet-insecure-tls`.
 */
export function installObservability(args: ObservabilityArgs): ObservabilityResources {
  const { provider } = args;

  const namespace = new k8s.core.v1.Namespace(
    "observability",
    {
      metadata: {
        name: OBSERVABILITY_NAMESPACE,
        // node-exporter needs hostPath + hostPID + hostNetwork, and Talos
        // enforces Pod Security `baseline` on every namespace except
        // kube-system. Splitting node-exporter into its own privileged
        // namespace and leaving Grafana/Prometheus/Loki at `baseline` is the
        // tighter arrangement and a worthwhile follow-up.
        labels: {
          "pod-security.kubernetes.io/enforce": "privileged",
          "pod-security.kubernetes.io/audit": "privileged",
          "pod-security.kubernetes.io/warn": "privileged",
        },
      },
    },
    { provider },
  );

  const rulesConfigMap = installObservabilityRules({ provider, namespace });

  const prometheus = installPrometheus({ provider, namespace, rulesConfigMap });
  const nodeExporter = installNodeExporter({ provider, namespace });
  const kubeStateMetrics = installKubeStateMetrics({ provider, namespace });

  const loki = installLoki({ provider, namespace });
  const alloy = installAlloy({ provider, namespace, loki });

  const dashboardConfigMaps = installDashboardConfigMaps({ provider, namespace });
  const grafana = installGrafana({ provider, namespace, dashboardConfigMaps });

  return {
    namespace,
    rulesConfigMap,
    prometheus,
    nodeExporter,
    kubeStateMetrics,
    loki,
    alloy,
    grafana,
  };
}
