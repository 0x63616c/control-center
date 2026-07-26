# The observability stack is hand-rolled: no Helm, no prometheus-operator, no CRDs

Prometheus, Grafana, Loki, Alloy, node-exporter and kube-state-metrics are declared as
hand-written `@pulumi/kubernetes` resources in `infra/src/observability/`, exactly like
`infra/src/temporal.ts` and `infra/src/nvidia.ts`. No Helm chart is rendered or released, no
operator is installed, and this stack adds no CRDs to the cluster.

This looked like the expensive option and is not. Dropping the *operator* is what makes
hand-rolling cheap, and the operator is most of kube-prometheus-stack's bulk: CRDs, a controller,
~50 alert rules we do not want, and multi-node assumptions that do not apply to a single Talos
node. What remains is six workloads and their config, at roughly the size of `temporal.ts`.

## What replaces each CRD

**`ServiceMonitor` / `PodMonitor` → `kubernetes_sd_configs` with `prometheus.io/*` pod
annotations.** A workload declares `scrape: { port }` on its `WorkloadSpec` and
`infra/src/component.ts` renders the annotations onto the pod template. This is a better fit for
ADR-0001 than the CRD was: the scrape target is declared next to the workload, and no central list
accumulates. The costs are real but small at this size — one endpoint per pod, and no per-target
scrape interval or `metric_relabel_configs`, so a single chatty App's high-cardinality series
cannot be dropped in isolation. A hand-written scrape job remains the escape hatch.

The annotation names are a community convention, not a Prometheus feature; the relabel block is
taken from the `prometheus-community/prometheus` chart's values. The port is required rather than
optional because Prometheus 3.x no longer appends default ports, so an annotated pod without one
resolves to a bare IP and fails.

**`PrometheusRule` → plain `rule_files:` from a ConfigMap.** The CRD is the derived form; the
kubernetes-mixin's native output is already a `groups:` file. The vendored rules live in
`infra/observability/rules/`, extracted from kube-prometheus's checked-in PrometheusRule
manifests with alerting rules stripped.

**CNPG's `enablePodMonitor` → a scrape job on `cnpg.io/podRole=instance`.** One job covers all
three databases with no per-cluster config, relabelling `cnpg.io/cluster` into `cluster_name`.
CloudNativePG has deprecated that field and now recommends managing scraping yourself, so this is
the supported path rather than a workaround.

## What we own as a result

Upgrades are ours: image tags are trivial, but kube-state-metrics' RBAC drifts between versions and
Loki's config schema changes between majors. The vendored rules must be re-extracted, and their
job-name rewrite re-applied, on each mixin bump — `docs/observability.md` records the procedure.

## Names that are load-bearing

The mixin rules select on literal job names, so the scrape jobs must stay named `kubelet`,
`cadvisor`, `kube-state-metrics` and `node-exporter`. Upstream has no `cadvisor` job — it uses
`job="kubelet"` disambiguated by a `metrics_path` label that kube-prometheus adds via relabeling —
so those selectors were rewritten to match our two-job layout. Datasource UIDs (`www-prometheus`,
`www-loki`) are equally fixed, because every vendored dashboard references them. Renaming any of
these empties dashboards silently, with nothing DOWN and no rule unhealthy.

`honor_labels: true` on the kube-state-metrics job belongs in the same category. Without it the
scrape overwrites each series' `namespace`/`pod` — which describe the object being reported on —
with the kube-state-metrics pod's own identity, and every `kube_pod_info` join in the mixin
collapses to a single pod.

## Talos constraints

`kube-scheduler`, `kube-controller-manager`, `kube-proxy` and `etcd` all bind to `127.0.0.1`, so
none is scraped and their rule groups and dashboards were removed rather than shipped permanently
red. Exposing etcd's metrics endpoint would require a node reboot — full cluster downtime on a
single control-plane node — and the documented endpoint is unauthenticated plain HTTP on the LAN.
The Kubernetes mixin ships no etcd rules regardless. If that trade ever changes, batch every
machine-config change into one apply, and use a full apply rather than `talosctl patch mc`, which
appends to list fields.

The kubelet's serving certificate is self-signed, so scrapes set `insecure_skip_verify` — the same
reason `metrics-server` runs `--kubelet-insecure-tls`.

## Rejected

**A Helm `Chart`/`Release` resource.** Rejected on the requester's explicit instruction, and it
would have been the only Helm in the repo — every other upstream component arrives as a pinned-URL
`k8s.yaml.ConfigFile`.

**Vendoring `helm template` output.** Auditable, but a large committed blob plus a regeneration
step, to install a controller whose CRDs we then would not use.

## Consequences

Alerting is out of scope entirely: no Alertmanager, no notification routing, no external prober.
Adding it later needs no rework here — alert rules load through the same `rule_files:` mechanism
the recording rules already use.

Every workload's config is hashed into a pod-template annotation so that a config change rolls the
pod. Without that, a mounted ConfigMap updates in place while the process keeps reading what it
loaded at boot, and a deploy reports success while the change sits inert.
