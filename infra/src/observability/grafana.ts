// Grafana, hand-written (#209 auth, #210 declarative provisioning).
//
// Two things here are deliberate and easy to undo by accident:
//
//   1. EVERYTHING IS PROVISIONED FROM FILES. Datasources and the dashboard
//      provider arrive as ConfigMaps, and the provider runs with
//      `allowUiUpdates: false`. Grafana's own SQLite database (on the PVC) holds
//      only user/session state; it is not where dashboards live. That is why the
//      datasource UIDs are hardcoded constants — dashboard JSON references
//      datasources by UID, so a Grafana-generated UID would break every vendored
//      dashboard the first time the PVC is recreated.
//
//   2. AUTHENTICATION IS CLOUDFLARE ACCESS, NOT GRAFANA. Access already
//      authenticates the user at the edge and cloudflared forwards the verified
//      identity as `Cf-Access-Authenticated-User-Email`. Grafana's auth proxy
//      trusts that header, so there is no second login and no password to
//      manage. The login form is disabled outright so it cannot become an
//      alternative, weaker way in.

import { createHash } from "node:crypto";
import * as k8s from "@pulumi/kubernetes";
import {
  GRAFANA_IMAGE,
  GRAFANA_PORT,
  LOKI_DATASOURCE_UID,
  LOKI_PORT,
  OBSERVABILITY_NAMESPACE,
  PROMETHEUS_DATASOURCE_UID,
  PROMETHEUS_PORT,
} from "./constants.ts";
import { DASHBOARDS_MOUNT_PATH, type DashboardConfigMapResources } from "./dashboards.ts";

const GRAFANA_NAME = "grafana";
const DATASOURCES_CONFIGMAP = "grafana-datasources";
const DASHBOARD_PROVIDER_CONFIGMAP = "grafana-dashboard-provider";
const DATA_PVC = "grafana-data";
const DATA_MOUNT_PATH = "/var/lib/grafana";
const PROVISIONING_PATH = "/etc/grafana/provisioning";

/**
 * Grafana's published images run as uid/gid 472. Without `fsGroup` the
 * local-lvm volume lands root-owned and Grafana cannot create its SQLite
 * database, which shows up as an immediate, repeating crash loop rather than a
 * permissions error anyone would recognise.
 */
const GRAFANA_UID = 472;

/**
 * Only in-cluster callers may assert the identity header. The auth proxy trusts
 * `Cf-Access-Authenticated-User-Email` completely, so if a request could reach
 * Grafana without passing through cloudflared, anyone could set that header and
 * become any user — including one that auto-signs-up as Admin. The whitelist is
 * the thing that makes header trust safe: it is the pod CIDR, so only cloudflared
 * (which runs in this cluster) can be the source. This is also why the Service
 * below is ClusterIP and never a LoadBalancer/MetalLB IP: the Cloudflare tunnel
 * must be the only path in.
 */
const CLUSTER_POD_CIDR = "10.244.0.0/16";

/** The public origin Access fronts. Grafana needs it for redirects and generated links. */
const GRAFANA_ROOT_URL = "https://grafana.worldwidewebb.co";

const labels = { app: GRAFANA_NAME };

export type GrafanaArgs = {
  provider: k8s.Provider;
  namespace: k8s.core.v1.Namespace;
  /** From `installDashboardConfigMaps()` — every ConfigMap here is mounted under the provider path. */
  dashboardConfigMaps: DashboardConfigMapResources;
};

export type GrafanaResources = {
  datasources: k8s.core.v1.ConfigMap;
  dashboardProvider: k8s.core.v1.ConfigMap;
  dataVolume: k8s.core.v1.PersistentVolumeClaim;
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
};

/**
 * Datasource provisioning. Both datasources are proxied (`access: proxy`), so
 * the browser never talks to Prometheus or Loki directly — they have no auth of
 * their own and are ClusterIP-only.
 */
function datasourcesYaml(): string {
  return [
    "apiVersion: 1",
    "datasources:",
    "  - name: Prometheus",
    "    type: prometheus",
    // UID is hardcoded, not generated: vendored dashboard JSON selects its
    // datasource by UID.
    `    uid: ${PROMETHEUS_DATASOURCE_UID}`,
    "    access: proxy",
    `    url: http://prometheus.${OBSERVABILITY_NAMESPACE}.svc.cluster.local:${PROMETHEUS_PORT}`,
    "    isDefault: true",
    "    editable: false",
    "  - name: Loki",
    "    type: loki",
    `    uid: ${LOKI_DATASOURCE_UID}`,
    "    access: proxy",
    `    url: http://loki.${OBSERVABILITY_NAMESPACE}.svc.cluster.local:${LOKI_PORT}`,
    "    isDefault: false",
    "    editable: false",
    "",
  ].join("\n");
}

/**
 * The auth-proxy configuration, expressed as env rather than a grafana.ini so it
 * stays visible next to the comment explaining why it is safe.
 */
function authProxyEnv(): k8s.types.input.core.v1.EnvVar[] {
  return [
    { name: "GF_AUTH_PROXY_ENABLED", value: "true" },
    { name: "GF_AUTH_PROXY_HEADER_NAME", value: "Cf-Access-Authenticated-User-Email" },
    { name: "GF_AUTH_PROXY_HEADER_PROPERTY", value: "email" },
    // Access decides who gets through; a user it lets in should not then hit a
    // "no such account" wall.
    { name: "GF_AUTH_PROXY_AUTO_SIGN_UP", value: "true" },
    // Issue a Grafana session cookie after the first proxied request, so
    // sub-requests (dashboard JSON, datasource proxy calls) do not each need to
    // re-run the sign-up path.
    { name: "GF_AUTH_PROXY_ENABLE_LOGIN_TOKEN", value: "true" },
    // See CLUSTER_POD_CIDR: the header is trusted, so the source must not be.
    { name: "GF_AUTH_PROXY_WHITELIST", value: CLUSTER_POD_CIDR },
    // Everyone Access admits is a household admin; there is no second tier of
    // user to model here.
    { name: "GF_USERS_AUTO_ASSIGN_ORG_ROLE", value: "Admin" },
    // No local login form and no anonymous access: Access is the only way in.
    { name: "GF_AUTH_DISABLE_LOGIN_FORM", value: "true" },
    { name: "GF_AUTH_ANONYMOUS_ENABLED", value: "false" },
    { name: "GF_SERVER_ROOT_URL", value: GRAFANA_ROOT_URL },
  ];
}

/** Volume name for a dashboard ConfigMap; DNS-1123 and within the 63-char limit. */
function dashboardVolumeName(configMapName: string): string {
  return configMapName.replace(/^grafana-dashboard-/, "dash-").slice(0, 63);
}

/**
 * @public - installs Grafana: provisioned datasources, the file-based dashboard
 * provider, its PVC, Deployment and ClusterIP Service. Wired up in
 * `observability/index.ts`.
 */
export function installGrafana(args: GrafanaArgs): GrafanaResources {
  const { provider, namespace, dashboardConfigMaps } = args;
  const datasourcesConfig = datasourcesYaml();
  const opts = { provider, dependsOn: [namespace] };

  const datasources = new k8s.core.v1.ConfigMap(
    DATASOURCES_CONFIGMAP,
    {
      metadata: { name: DATASOURCES_CONFIGMAP, namespace: OBSERVABILITY_NAMESPACE, labels },
      data: { "datasources.yaml": datasourcesConfig },
    },
    opts,
  );

  const dashboardProvider = new k8s.core.v1.ConfigMap(
    DASHBOARD_PROVIDER_CONFIGMAP,
    {
      metadata: { name: DASHBOARD_PROVIDER_CONFIGMAP, namespace: OBSERVABILITY_NAMESPACE, labels },
      data: { "dashboards.yaml": dashboardConfigMaps.providerYaml },
    },
    opts,
  );

  const dataVolume = new k8s.core.v1.PersistentVolumeClaim(
    DATA_PVC,
    {
      metadata: { name: DATA_PVC, namespace: OBSERVABILITY_NAMESPACE, labels },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: "local-lvm",
        // Grafana stores only its SQLite DB, sessions and the plugin cache here
        // — dashboards and datasources come from ConfigMaps. 2Gi is generous.
        resources: { requests: { storage: "2Gi" } },
      },
    },
    opts,
  );

  // Each dashboard ConfigMap gets its own directory under the provider path.
  // Grafana's file provider walks the tree, so a directory per ConfigMap reads
  // identically to one flat folder — and unlike `subPath` mounts, these still
  // pick up ConfigMap updates without a pod restart.
  const dashboardVolumes = dashboardConfigMaps.configMaps.map((d) => ({
    name: dashboardVolumeName(d.name),
    configMap: { name: d.name },
  }));
  const dashboardMounts = dashboardConfigMaps.configMaps.map((d) => ({
    name: dashboardVolumeName(d.name),
    mountPath: `${DASHBOARDS_MOUNT_PATH}/${d.name.replace(/^grafana-dashboard-/, "")}`,
    readOnly: true,
  }));

  const deployment = new k8s.apps.v1.Deployment(
    GRAFANA_NAME,
    {
      metadata: { name: GRAFANA_NAME, namespace: OBSERVABILITY_NAMESPACE, labels },
      spec: {
        replicas: 1,
        // Recreate, not RollingUpdate: the data PVC is ReadWriteOnce, so a
        // second pod could never attach it and the rollout would wedge.
        strategy: { type: "Recreate" },
        selector: { matchLabels: labels },
        template: {
          metadata: {
            labels,
            // Roll the pod when its config changes: a mounted ConfigMap updates
            // in place, but the process only reads it at boot, so without this
            // a config change sits deployed-but-inert until an unrelated
            // restart.
            annotations: {
              "checksum/config": createHash("sha256")
                .update(datasourcesConfig)
                .update(dashboardConfigMaps.providerYaml)
                .digest("hex"),
            },
          },
          spec: {
            automountServiceAccountToken: false,
            securityContext: { fsGroup: GRAFANA_UID },
            containers: [
              {
                name: GRAFANA_NAME,
                image: GRAFANA_IMAGE,
                env: authProxyEnv(),
                ports: [{ name: "http", containerPort: GRAFANA_PORT }],
                volumeMounts: [
                  { name: "data", mountPath: DATA_MOUNT_PATH },
                  {
                    name: "datasources",
                    mountPath: `${PROVISIONING_PATH}/datasources`,
                    readOnly: true,
                  },
                  {
                    name: "dashboard-provider",
                    mountPath: `${PROVISIONING_PATH}/dashboards`,
                    readOnly: true,
                  },
                  ...dashboardMounts,
                ],
                readinessProbe: {
                  httpGet: { path: "/api/health", port: GRAFANA_PORT },
                  initialDelaySeconds: 10,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: "/api/health", port: GRAFANA_PORT },
                  initialDelaySeconds: 60,
                  periodSeconds: 30,
                },
                resources: {
                  limits: { memory: "512Mi" },
                  requests: { cpu: "100m", memory: "256Mi" },
                },
              },
            ],
            volumes: [
              { name: "data", persistentVolumeClaim: { claimName: DATA_PVC } },
              { name: "datasources", configMap: { name: DATASOURCES_CONFIGMAP } },
              { name: "dashboard-provider", configMap: { name: DASHBOARD_PROVIDER_CONFIGMAP } },
              ...dashboardVolumes,
            ],
          },
        },
      },
    },
    {
      ...opts,
      dependsOn: [
        namespace,
        datasources,
        dashboardProvider,
        dataVolume,
        ...dashboardConfigMaps.configMaps.map((d) => d.configMap),
      ],
    },
  );

  const service = new k8s.core.v1.Service(
    GRAFANA_NAME,
    {
      metadata: { name: GRAFANA_NAME, namespace: OBSERVABILITY_NAMESPACE, labels },
      spec: {
        // ClusterIP, always. See CLUSTER_POD_CIDR — an IP reachable from the LAN
        // would let anyone on the network forge the identity header.
        type: "ClusterIP",
        selector: labels,
        ports: [{ name: "http", port: GRAFANA_PORT, targetPort: GRAFANA_PORT }],
      },
    },
    opts,
  );

  return { datasources, dashboardProvider, dataVolume, deployment, service };
}
