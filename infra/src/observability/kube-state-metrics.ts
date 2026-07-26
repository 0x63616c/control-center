/**
 * kube-state-metrics (#33, ADR #207) — object-state metrics for the cluster
 * (deployment replicas, pod phase, PVC capacity, cronjob schedules, …).
 *
 * Hand-rolled from the upstream `examples/standard` manifests (v2.19.x) rather
 * than the Helm chart. The ClusterRole below is a verbatim transcription of
 * `kubernetes/kube-state-metrics@v2.19.1 examples/standard/cluster-role.yaml`:
 * kube-state-metrics silently drops a WHOLE metric family when its list/watch
 * verb is missing (no crash, no log), so trimming this list is how you end up
 * with dashboards that are quietly half-empty. Leave it complete.
 */

import * as k8s from "@pulumi/kubernetes";
import {
  KUBE_STATE_METRICS_IMAGE,
  KUBE_STATE_METRICS_PORT,
  OBSERVABILITY_NAMESPACE,
} from "./constants.ts";

const NAME = "kube-state-metrics";

/** Selector shared by the Deployment, its pod template and the Service. */
const LABELS = { "app.kubernetes.io/name": NAME };

/**
 * Self-metrics (scrape durations, watch errors). Distinct from the :8080
 * metrics port; only :8080 carries the cluster-state metrics the dashboards
 * and mixin rules read.
 */
const TELEMETRY_PORT = 8081;

export type KubeStateMetricsArgs = {
  provider: k8s.Provider;
  namespace: k8s.core.v1.Namespace;
};

export type KubeStateMetricsResources = {
  serviceAccount: k8s.core.v1.ServiceAccount;
  clusterRole: k8s.rbac.v1.ClusterRole;
  clusterRoleBinding: k8s.rbac.v1.ClusterRoleBinding;
  deployment: k8s.apps.v1.Deployment;
  /** Prometheus's `role: endpoints` SD target for the `kube-state-metrics` job. */
  service: k8s.core.v1.Service;
};

/**
 * @public - ServiceAccount + cluster-wide RBAC + Deployment + Service.
 * Consumed by infra/src/observability/index.ts.
 */
export function installKubeStateMetrics(args: KubeStateMetricsArgs): KubeStateMetricsResources {
  const { provider, namespace } = args;
  const opts = { provider, dependsOn: [namespace] };

  const serviceAccount = new k8s.core.v1.ServiceAccount(
    NAME,
    {
      metadata: { name: NAME, namespace: OBSERVABILITY_NAMESPACE, labels: LABELS },
      // Token automount stays ON: this SA's token is exactly how the exporter
      // authenticates its cluster-wide list/watch against the API server.
    },
    opts,
  );

  const clusterRole = new k8s.rbac.v1.ClusterRole(
    NAME,
    {
      metadata: { name: NAME, labels: LABELS },
      rules: [
        {
          apiGroups: [""],
          resources: [
            "configmaps",
            // Metadata only — kube-state-metrics never exports Secret VALUES,
            // just names/types/ages. Still the single most sensitive grant here.
            "secrets",
            "nodes",
            "pods",
            "services",
            "serviceaccounts",
            "resourcequotas",
            "replicationcontrollers",
            "limitranges",
            "persistentvolumeclaims",
            "persistentvolumes",
            "namespaces",
            "endpoints",
          ],
          verbs: ["list", "watch"],
        },
        {
          apiGroups: ["apps"],
          resources: ["statefulsets", "daemonsets", "deployments", "replicasets"],
          verbs: ["list", "watch"],
        },
        { apiGroups: ["batch"], resources: ["cronjobs", "jobs"], verbs: ["list", "watch"] },
        {
          apiGroups: ["autoscaling"],
          resources: ["horizontalpodautoscalers"],
          verbs: ["list", "watch"],
        },
        // `create` (not list/watch): used by the optional self-auth check, kept
        // to stay byte-for-byte with the upstream standard manifest.
        { apiGroups: ["authentication.k8s.io"], resources: ["tokenreviews"], verbs: ["create"] },
        {
          apiGroups: ["authorization.k8s.io"],
          resources: ["subjectaccessreviews"],
          verbs: ["create"],
        },
        { apiGroups: ["policy"], resources: ["poddisruptionbudgets"], verbs: ["list", "watch"] },
        {
          apiGroups: ["certificates.k8s.io"],
          resources: ["certificatesigningrequests"],
          verbs: ["list", "watch"],
        },
        {
          apiGroups: ["discovery.k8s.io"],
          resources: ["endpointslices"],
          verbs: ["list", "watch"],
        },
        {
          apiGroups: ["storage.k8s.io"],
          resources: ["storageclasses", "volumeattachments"],
          verbs: ["list", "watch"],
        },
        {
          apiGroups: ["admissionregistration.k8s.io"],
          resources: ["mutatingwebhookconfigurations", "validatingwebhookconfigurations"],
          verbs: ["list", "watch"],
        },
        {
          apiGroups: ["networking.k8s.io"],
          resources: ["networkpolicies", "ingressclasses", "ingresses"],
          verbs: ["list", "watch"],
        },
        { apiGroups: ["coordination.k8s.io"], resources: ["leases"], verbs: ["list", "watch"] },
        {
          apiGroups: ["rbac.authorization.k8s.io"],
          resources: ["clusterrolebindings", "clusterroles", "rolebindings", "roles"],
          verbs: ["list", "watch"],
        },
      ],
    },
    opts,
  );

  const clusterRoleBinding = new k8s.rbac.v1.ClusterRoleBinding(
    NAME,
    {
      metadata: { name: NAME, labels: LABELS },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: NAME },
      subjects: [{ kind: "ServiceAccount", name: NAME, namespace: OBSERVABILITY_NAMESPACE }],
    },
    { provider, dependsOn: [namespace, clusterRole, serviceAccount] },
  );

  const deployment = new k8s.apps.v1.Deployment(
    NAME,
    {
      metadata: { name: NAME, namespace: OBSERVABILITY_NAMESPACE, labels: LABELS },
      spec: {
        // Exactly one: every replica watches and exports the SAME objects, so a
        // second replica is duplicate series, not redundancy.
        replicas: 1,
        selector: { matchLabels: LABELS },
        template: {
          metadata: { labels: LABELS },
          spec: {
            serviceAccountName: NAME,
            containers: [
              {
                name: NAME,
                image: KUBE_STATE_METRICS_IMAGE,
                ports: [
                  {
                    name: "http-metrics",
                    containerPort: KUBE_STATE_METRICS_PORT,
                    protocol: "TCP",
                  },
                  { name: "telemetry", containerPort: TELEMETRY_PORT, protocol: "TCP" },
                ],
                // Requests only — never a cpu limit (repo-wide rule). Throttling
                // this during a relist stalls the watch cache and produces stale
                // metrics rather than a visible failure.
                resources: {
                  requests: { cpu: "20m", memory: "128Mi" },
                  limits: { memory: "512Mi" },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  runAsNonRoot: true,
                  runAsUser: 65534,
                  capabilities: { drop: ["ALL"] },
                  seccompProfile: { type: "RuntimeDefault" },
                },
                livenessProbe: {
                  httpGet: { path: "/livez", port: KUBE_STATE_METRICS_PORT },
                  initialDelaySeconds: 5,
                  timeoutSeconds: 5,
                },
                readinessProbe: {
                  // Readiness deliberately hangs off the TELEMETRY port: :8080
                  // only starts serving once the initial relist finishes, so
                  // probing it is what upstream uses to gate traffic.
                  httpGet: { path: "/readyz", port: TELEMETRY_PORT },
                  initialDelaySeconds: 5,
                  timeoutSeconds: 5,
                },
              },
            ],
          },
        },
      },
    },
    { provider, dependsOn: [namespace, clusterRoleBinding] },
  );

  const service = new k8s.core.v1.Service(
    NAME,
    {
      metadata: { name: NAME, namespace: OBSERVABILITY_NAMESPACE, labels: LABELS },
      spec: {
        type: "ClusterIP",
        selector: LABELS,
        ports: [
          {
            name: "http-metrics",
            port: KUBE_STATE_METRICS_PORT,
            targetPort: KUBE_STATE_METRICS_PORT,
            protocol: "TCP",
          },
          {
            name: "telemetry",
            port: TELEMETRY_PORT,
            targetPort: TELEMETRY_PORT,
            protocol: "TCP",
          },
        ],
      },
    },
    opts,
  );

  return { serviceAccount, clusterRole, clusterRoleBinding, deployment, service };
}
