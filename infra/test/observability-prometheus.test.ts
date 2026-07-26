import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { buildPrometheusConfig } from "../src/observability/scrape-config.ts";

type Relabel = {
  source_labels?: string[];
  action?: string;
  regex?: string;
  target_label?: string;
  replacement?: string;
};
type Job = { job_name: string; relabel_configs?: Relabel[] };
type Config = {
  global: { external_labels: Record<string, string> };
  rule_files: string[];
  scrape_configs: Job[];
};

const config = parse(buildPrometheusConfig()) as Config;
const jobNames = config.scrape_configs.map((j) => j.job_name);
const job = (name: string) => {
  const found = config.scrape_configs.find((j) => j.job_name === name);
  if (!found) throw new Error(`no scrape job named ${name}`);
  return found;
};

describe("buildPrometheusConfig", () => {
  test("emits parseable YAML with the cluster external label and the rules glob", () => {
    expect(config.global.external_labels.cluster).toBe("home-server");
    expect(config.rule_files).toEqual(["/etc/prometheus/rules/*.yaml"]);
  });

  // The vendored kubernetes-mixin recording rules select on these names
  // literally. Renaming one does not break the scrape, it silently empties
  // every mixin-derived dashboard panel.
  test.each([
    "kubelet",
    "cadvisor",
    "kube-state-metrics",
    "node-exporter",
  ])("keeps the mixin-critical job name %s", (name) => {
    expect(jobNames).toContain(name);
  });

  test("has no near-miss aliases of the mixin job names", () => {
    expect(jobNames).not.toContain("kubernetes-cadvisor");
    expect(jobNames).not.toContain("kubernetes-nodes");
    expect(jobNames).not.toContain("kubernetes-nodes-cadvisor");
  });

  // These all bind to 127.0.0.1 on Talos, so a scrape job for them would sit
  // permanently DOWN. Deliberately out of scope.
  test.each([
    "kube-scheduler",
    "kube-controller-manager",
    "kube-proxy",
    "etcd",
  ])("does not scrape %s (Talos binds it to localhost)", (name) => {
    expect(jobNames).not.toContain(name);
  });

  test("cadvisor and kubelet share discovery but differ in metrics path", () => {
    const path = (name: string) =>
      job(name).relabel_configs?.find((r) => r.target_label === "__metrics_path__")?.replacement;
    expect(path("kubelet")).toBe("/metrics");
    expect(path("cadvisor")).toBe("/metrics/cadvisor");
  });

  // The Service exposes `http-metrics` (8080) AND `telemetry` (8081); without
  // the port keep, one job produces two disjoint series sets.
  test("kube-state-metrics scrapes only the http-metrics port", () => {
    const keep = job("kube-state-metrics").relabel_configs?.find((r) => r.action === "keep");
    expect(keep?.source_labels).toContain("__meta_kubernetes_endpoint_port_name");
    expect(keep?.regex).toContain("http-metrics");
    expect(keep?.regex).not.toContain("telemetry");
  });

  test("node-exporter selects on the label the DaemonSet actually sets", () => {
    const keep = job("node-exporter").relabel_configs?.find((r) => r.action === "keep");
    expect(keep?.source_labels).toContain("__meta_kubernetes_pod_label_app_kubernetes_io_name");
    expect(keep?.regex).toBe("observability;node-exporter");
  });

  test("node-exporter sets instance to the node name so node.rules can join", () => {
    const instance = job("node-exporter").relabel_configs?.find(
      (r) => r.target_label === "instance",
    );
    expect(instance?.source_labels).toEqual(["__meta_kubernetes_pod_node_name"]);
  });

  test("cnpg keeps only CNPG instance pods, on the podRole label", () => {
    const keep = job("cnpg").relabel_configs?.find(
      (r) => r.action === "keep" && r.source_labels?.[0]?.includes("cnpg_io_podRole"),
    );
    expect(keep).toBeDefined();
    expect(keep?.regex).toBe("instance");
  });

  test("cnpg writes cluster_name, never overwriting the cluster external label", () => {
    const targets = job("cnpg").relabel_configs?.map((r) => r.target_label);
    expect(targets).toContain("cluster_name");
    expect(targets).not.toContain("cluster");
  });
});
