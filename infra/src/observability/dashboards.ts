// Grafana dashboards, as checked-in JSON turned into ConfigMaps (#210).
//
// The whole point of this file is that the dashboards in git are the source of
// truth. Grafana's file provider is pointed at a directory (see
// `dashboardProviderYaml()`) with `allowUiUpdates: false`, so a dashboard edited
// in the browser is reverted on the next provisioning sweep. Editing a dashboard
// means editing the JSON under `infra/observability/dashboards/` and deploying.
//
// ONE ConfigMap PER FILE, deliberately: a ConfigMap is capped at ~1 MiB by etcd
// and a single Grafana dashboard's JSON routinely runs to hundreds of KiB, so a
// combined ConfigMap would silently work until the day someone vendors one
// dashboard too many and the whole set stops applying.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as k8s from "@pulumi/kubernetes";
import { OBSERVABILITY_NAMESPACE } from "./constants.ts";

/**
 * Where Grafana's file provider looks, inside the pod. `grafana.ts` projects
 * every ConfigMap below underneath this path.
 */
export const DASHBOARDS_MOUNT_PATH = "/var/lib/grafana/dashboards";

/**
 * The vendored dashboard JSON, resolved from THIS FILE's location rather than
 * `process.cwd()`. Pulumi is invoked from several different working directories
 * (the stack dir, the repo root, CI), and this repo has already been bitten by
 * cwd-relative resolution more than once — see `scripts/apps-gen.ts`, which
 * carries the same note.
 */
const DASHBOARD_SOURCE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "observability",
  "dashboards",
);

/** One vendored dashboard file and the ConfigMap holding it. */
export type DashboardConfigMap = {
  /** File name as vendored, e.g. `k8s-views-global.json`. This is the key inside the ConfigMap. */
  fileName: string;
  /** ConfigMap object name, `grafana-dashboard-<basename>`. */
  name: string;
  configMap: k8s.core.v1.ConfigMap;
};

export type DashboardConfigMapArgs = {
  provider: k8s.Provider;
  namespace: k8s.core.v1.Namespace;
};

export type DashboardConfigMapResources = {
  /** Empty when nothing is vendored yet — Grafana still starts, with no dashboards. */
  configMaps: DashboardConfigMap[];
  /** Contents of Grafana's `provisioning/dashboards/dashboards.yaml`. */
  providerYaml: string;
};

/**
 * Grafana's dashboard provider config.
 *
 * `allowUiUpdates: false` is the load-bearing line: with it Grafana refuses to
 * persist browser edits to a provisioned dashboard, so the checked-in JSON stays
 * the only way a dashboard changes. `disableDeletion` stops a stray delete from
 * removing a dashboard until the next sweep restores it.
 *
 * `foldersFromFilesStructure` is off: every dashboard sits flat in one directory,
 * so there is no structure to mirror.
 */
export function dashboardProviderYaml(): string {
  return [
    "apiVersion: 1",
    "providers:",
    "  - name: www-observability",
    "    orgId: 1",
    "    type: file",
    "    disableDeletion: true",
    "    allowUiUpdates: false",
    "    updateIntervalSeconds: 30",
    "    options:",
    `      path: ${DASHBOARDS_MOUNT_PATH}`,
    "      foldersFromFilesStructure: false",
    "",
  ].join("\n");
}

/** A file name is not automatically a valid k8s object name; a ConfigMap name is DNS-1123. */
function objectNameFor(fileName: string): string {
  const base = fileName
    .replace(/\.json$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) throw new Error(`dashboards: "${fileName}" has no usable name for a ConfigMap`);
  return `grafana-dashboard-${base}`;
}

/** Vendored dashboard files, sorted so the resource set is deterministic across runs. */
function dashboardFileNames(): string[] {
  if (!existsSync(DASHBOARD_SOURCE_DIR)) return [];
  return readdirSync(DASHBOARD_SOURCE_DIR)
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .sort();
}

/**
 * @public - one ConfigMap per vendored dashboard, plus the provider config that
 * tells Grafana where to find them. Consumed by `installGrafana()`.
 *
 * A dashboard whose JSON does not parse throws HERE, at preview time. Grafana
 * would otherwise start fine and simply log the parse failure into a container
 * log nobody reads, leaving a dashboard silently missing from a stack whose
 * entire job is to show you what is missing.
 */
export function installDashboardConfigMaps(
  args: DashboardConfigMapArgs,
): DashboardConfigMapResources {
  const { provider, namespace } = args;
  const opts = { provider, dependsOn: [namespace] };

  const configMaps = dashboardFileNames().map((fileName): DashboardConfigMap => {
    const contents = readFileSync(join(DASHBOARD_SOURCE_DIR, fileName), "utf8");
    try {
      JSON.parse(contents);
    } catch (error) {
      throw new Error(
        `dashboards: ${fileName} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const name = objectNameFor(fileName);
    const configMap = new k8s.core.v1.ConfigMap(
      name,
      {
        metadata: {
          name,
          namespace: OBSERVABILITY_NAMESPACE,
          // Not consumed by a sidecar (there is none) — this labels the object
          // for a human running `kubectl get cm -l`.
          labels: { "grafana-dashboard": "true" },
        },
        data: { [fileName]: contents },
      },
      opts,
    );
    return { fileName, name, configMap };
  });

  return { configMaps, providerYaml: dashboardProviderYaml() };
}
