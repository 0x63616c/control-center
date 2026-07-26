// Prometheus, hand-written: ServiceAccount + RBAC, config ConfigMap, a PVC for
// the TSDB, a single-replica Deployment and a ClusterIP Service. No operator,
// no CRDs (ADR #207) — the whole server is legible in one file.

import { createHash } from "node:crypto";
import * as k8s from "@pulumi/kubernetes";
import {
  OBSERVABILITY_NAMESPACE,
  PROMETHEUS_IMAGE,
  PROMETHEUS_PORT,
  PROMETHEUS_RETENTION,
} from "./constants.ts";
import {
  buildPrometheusConfig,
  PROMETHEUS_CONFIG_DIR,
  PROMETHEUS_CONFIG_FILE,
  PROMETHEUS_DATA_DIR,
  PROMETHEUS_RULES_DIR,
} from "./scrape-config.ts";

const NAME = "prometheus";
const CONFIG_MAP_NAME = "prometheus-config";
const CLAIM_NAME = "prometheus-data";
/**
 * 15d of retention for this cluster's series volume fits comfortably; the PVC
 * is the real bound, since `local-path` carves out of the node's root disk and
 * a full root disk takes the cluster down, not just Prometheus.
 */
const CLAIM_SIZE = "30Gi";
/**
 * The official image runs as `nobody`. local-path mints the host directory
 * root-owned, so without an fsGroup the container crash-loops on "permission
 * denied" opening the TSDB — the single most common hand-rolled-Prometheus
 * failure.
 */
const NOBODY_UID = 65534;

const labels = { app: NAME };

export type PrometheusArgs = {
  provider: k8s.Provider;
  namespace: k8s.core.v1.Namespace;
  /**
   * ConfigMap of vendored kubernetes-mixin recording rules, mounted at
   * {@link PROMETHEUS_RULES_DIR}. Owned by another module and wired by
   * observability/index.ts; when absent an emptyDir is mounted instead so
   * Prometheus still boots (its `rule_files` glob simply matches nothing).
   */
  rulesConfigMap?: k8s.core.v1.ConfigMap;
};

export type PrometheusResources = {
  serviceAccount: k8s.core.v1.ServiceAccount;
  clusterRole: k8s.rbac.v1.ClusterRole;
  clusterRoleBinding: k8s.rbac.v1.ClusterRoleBinding;
  config: k8s.core.v1.ConfigMap;
  claim: k8s.core.v1.PersistentVolumeClaim;
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
};

export function installPrometheus(args: PrometheusArgs): PrometheusResources {
  const { provider, namespace, rulesConfigMap } = args;
  const configYaml = buildPrometheusConfig();
  const opts = { provider, dependsOn: [namespace] };

  const serviceAccount = new k8s.core.v1.ServiceAccount(
    NAME,
    { metadata: { name: NAME, namespace: OBSERVABILITY_NAMESPACE, labels } },
    opts,
  );

  const clusterRole = new k8s.rbac.v1.ClusterRole(
    NAME,
    {
      metadata: { name: NAME, labels },
      rules: [
        {
          apiGroups: [""],
          // `nodes/metrics` is the one people leave out; without it the kubelet
          // and cadvisor targets return 403 while every other target is green,
          // which reads like a TLS problem and is not.
          resources: ["nodes", "nodes/metrics", "nodes/proxy", "services", "endpoints", "pods"],
          verbs: ["get", "list", "watch"],
        },
        { apiGroups: [""], resources: ["configmaps"], verbs: ["get"] },
        // Kubelet metrics are served on non-resource URLs, so resource rules
        // above do not cover them.
        { nonResourceURLs: ["/metrics", "/metrics/cadvisor"], verbs: ["get"] },
      ],
    },
    { provider },
  );

  const clusterRoleBinding = new k8s.rbac.v1.ClusterRoleBinding(
    NAME,
    {
      metadata: { name: NAME, labels },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: NAME },
      subjects: [{ kind: "ServiceAccount", name: NAME, namespace: OBSERVABILITY_NAMESPACE }],
    },
    { provider, dependsOn: [clusterRole, serviceAccount] },
  );

  const config = new k8s.core.v1.ConfigMap(
    CONFIG_MAP_NAME,
    {
      metadata: { name: CONFIG_MAP_NAME, namespace: OBSERVABILITY_NAMESPACE, labels },
      data: { "prometheus.yml": configYaml },
    },
    opts,
  );

  const claim = new k8s.core.v1.PersistentVolumeClaim(
    CLAIM_NAME,
    {
      metadata: { name: CLAIM_NAME, namespace: OBSERVABILITY_NAMESPACE, labels },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: "local-path",
        resources: { requests: { storage: CLAIM_SIZE } },
      },
    },
    opts,
  );

  const deployment = new k8s.apps.v1.Deployment(
    NAME,
    {
      metadata: { name: NAME, namespace: OBSERVABILITY_NAMESPACE, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        // The TSDB PVC is ReadWriteOnce: a rolling update would need the new
        // pod to mount the volume while the old one still holds it, and would
        // deadlock waiting.
        strategy: { type: "Recreate" },
        template: {
          metadata: {
            labels,
            // Roll the pod when the scrape config changes. A mounted ConfigMap
            // updates in place but Prometheus only reads it at boot, so without
            // this a config fix sits deployed-but-inert until some unrelated
            // restart — which is exactly how the kube-state-metrics
            // honor_labels fix looked "applied" while the running server was
            // still using the old config.
            annotations: {
              "checksum/config": createHash("sha256").update(configYaml).digest("hex"),
            },
          },
          spec: {
            serviceAccountName: NAME,
            securityContext: { fsGroup: NOBODY_UID, runAsUser: NOBODY_UID, runAsNonRoot: true },
            containers: [
              {
                name: NAME,
                image: PROMETHEUS_IMAGE,
                args: [
                  `--config.file=${PROMETHEUS_CONFIG_FILE}`,
                  `--storage.tsdb.path=${PROMETHEUS_DATA_DIR}`,
                  `--storage.tsdb.retention.time=${PROMETHEUS_RETENTION}`,
                  // Lets a config/rules change be applied with POST /-/reload
                  // instead of deleting the pod (which, with Recreate + a RWO
                  // volume, means a gap in scraping).
                  "--web.enable-lifecycle",
                ],
                ports: [{ name: "http", containerPort: PROMETHEUS_PORT }],
                volumeMounts: [
                  { name: "config", mountPath: PROMETHEUS_CONFIG_DIR },
                  { name: "rules", mountPath: PROMETHEUS_RULES_DIR },
                  { name: "data", mountPath: PROMETHEUS_DATA_DIR },
                ],
                readinessProbe: {
                  httpGet: { path: "/-/ready", port: PROMETHEUS_PORT },
                  initialDelaySeconds: 10,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: "/-/healthy", port: PROMETHEUS_PORT },
                  // WAL replay after an unclean stop can take minutes and the
                  // server does not answer /-/healthy until it finishes; a
                  // tight liveness probe turns that into a restart loop.
                  initialDelaySeconds: 60,
                  periodSeconds: 30,
                  failureThreshold: 10,
                },
                resources: {
                  // Memory limit only — never a cpu limit (throttling a
                  // scraper makes it miss scrape intervals, which looks like
                  // the *targets* being down). The node is 20 cores / 32 GiB,
                  // so the headroom is real.
                  limits: { memory: "4Gi" },
                  requests: { cpu: "250m", memory: "1Gi" },
                },
              },
            ],
            volumes: [
              { name: "config", configMap: { name: CONFIG_MAP_NAME } },
              rulesConfigMap
                ? { name: "rules", configMap: { name: rulesConfigMap.metadata.name } }
                : { name: "rules", emptyDir: {} },
              { name: "data", persistentVolumeClaim: { claimName: CLAIM_NAME } },
            ],
          },
        },
      },
    },
    {
      provider,
      dependsOn: rulesConfigMap
        ? [namespace, config, claim, clusterRoleBinding, rulesConfigMap]
        : [namespace, config, claim, clusterRoleBinding],
    },
  );

  const service = new k8s.core.v1.Service(
    NAME,
    {
      metadata: { name: NAME, namespace: OBSERVABILITY_NAMESPACE, labels },
      spec: {
        // ClusterIP, never LoadBalancer: Prometheus has no authentication of
        // its own, and its API can delete series. Grafana reaches it in-cluster;
        // a human reaches it through `kubectl port-forward`.
        type: "ClusterIP",
        selector: labels,
        ports: [{ name: "http", port: PROMETHEUS_PORT, targetPort: PROMETHEUS_PORT }],
      },
    },
    opts,
  );

  return { serviceAccount, clusterRole, clusterRoleBinding, config, claim, deployment, service };
}
