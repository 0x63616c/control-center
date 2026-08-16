import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as k8s from "@pulumi/kubernetes";
import { OBSERVABILITY_NAMESPACE } from "./constants.ts";

/**
 * Vendored kubernetes-mixin RECORDING rules, mounted into Prometheus at
 * `/etc/prometheus/rules`.
 *
 * These exist because the standard Kubernetes dashboards do not query raw
 * metrics — they query recording rules like
 * `node_namespace_pod_container:container_cpu_usage_seconds_total:sum_rate5m`.
 * Without the rule files the dashboards render empty with no error anywhere,
 * which looks like a dashboard bug rather than a missing input.
 *
 * The PrometheusRule CRD is the *derived* form of these; the mixin's native
 * output is a plain `groups:` file, which is why no operator is needed (#207).
 * Kubernetes-mixin alerting rules are deliberately stripped. Small, owned
 * product alerts may live beside the recording rules when they have a checked-in
 * runbook; Prometheus evaluates them even though this stack does not yet route
 * notifications through Alertmanager.
 */
// Entry-relative, not cwd-relative: Pulumi and vitest run from different
// directories, and `import.meta.dir` is bun-only so it does not type-check.
const RULES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../observability/rules",
);

export type ObservabilityRulesArgs = {
  provider: k8s.Provider;
  namespace: k8s.core.v1.Namespace;
};

/**
 * One ConfigMap holding every rule file. Rule files are small (tens of KB
 * total) so they fit comfortably under the ~1 MiB ConfigMap ceiling — unlike
 * the dashboards, which get one ConfigMap each.
 */
export function installObservabilityRules(args: ObservabilityRulesArgs): k8s.core.v1.ConfigMap {
  const { provider, namespace } = args;

  const data: Record<string, string> = {};
  if (fs.existsSync(RULES_DIR)) {
    for (const file of fs.readdirSync(RULES_DIR).sort()) {
      if (!file.endsWith(".yaml")) continue;
      data[file] = fs.readFileSync(path.join(RULES_DIR, file), "utf8");
    }
  }

  return new k8s.core.v1.ConfigMap(
    "prometheus-rules",
    {
      metadata: { name: "prometheus-rules", namespace: OBSERVABILITY_NAMESPACE },
      data,
    },
    { provider, dependsOn: [namespace] },
  );
}
