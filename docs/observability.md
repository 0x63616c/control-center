# Observability (#33)

Metrics, logs and dashboards for the `home-server` cluster. Prometheus +
node-exporter + kube-state-metrics for metrics, Loki + Alloy for logs, Grafana as
the single surface.

The whole stack is **hand-written Pulumi**: no Helm, no prometheus-operator, no
CRDs (ADR #207). Source lives in `infra/src/observability/`; the vendored data
(dashboard JSON, recording rules) lives in `infra/observability/`.

---

## 1. What runs where

Everything is in the `observability` namespace, which is labelled Pod Security
`privileged` — node-exporter needs hostPath/hostPID/hostNetwork and Talos
enforces `baseline` on every other namespace. (Splitting node-exporter into its
own privileged namespace and leaving the rest `baseline` is the tighter
arrangement; it is a known follow-up, not done.)

| workload | kind | port | what it is |
|----------|------|------|------------|
| `prometheus` | Deployment (`Recreate`, 1 replica) | 9090 | TSDB + scraper, RWO PVC |
| `node-exporter` | DaemonSet (hostNetwork/hostPID) | 9100 | host CPU/mem/disk/net from the node's own `/proc`, `/sys` |
| `kube-state-metrics` | Deployment | 8080 (`http-metrics`), 8081 (`telemetry`) | object-state series (replicas, pod phase, PVC capacity, …) |
| `loki` | Deployment (`Recreate`, 1 replica) | 3100 | single-binary (`-target=all`) log store on the filesystem |
| `alloy` | DaemonSet | 12345 | log collector; streams from the Kubernetes pod-log API |
| `grafana` | Deployment (`Recreate`, 1 replica) | 3000 | the only UI |

Everything is `ClusterIP`. Prometheus and Loki have no authentication of their
own; Grafana proxies both (`access: proxy`), so a browser never talks to them
directly. To poke Prometheus by hand, `kubectl port-forward`.

Alloy is a DaemonSet with a control-plane toleration, so it keeps collecting if
a second node is ever added. It uses `loki.source.kubernetes` (the pod-log API,
the same endpoint `kubectl logs -f` reads) rather than tailing `/var/log/pods`,
so it needs **no hostPath and no privileges** — only RBAC on `pods/log`. Do not
"simplify" it into a file tailer.

Entry point: `installObservability()` in `infra/src/observability/index.ts`.

---

## 2. How to reach it

`https://grafana.worldwidewebb.co`, fronted by Cloudflare Access with an
**email-OTP** policy (`infra/cloudflare/src/access.ts`). The tunnel route points
at `http://grafana.observability.svc.cluster.local:3000`
(`infra/cloudflare/src/routes.ts`).

There is no Grafana login. Access authenticates at the edge, cloudflared
forwards the verified identity as `Cf-Access-Authenticated-User-Email`, and
Grafana's auth proxy trusts that header outright. The local login form is
disabled (`GF_AUTH_DISABLE_LOGIN_FORM`) and anonymous access is off, so Access is
the only way in. Anyone Access admits is auto-signed-up as `Admin` — there is
one tier of user here.

> **Trusting a header is only safe because nothing untrusted can set it.**
> Two things enforce that, together:
>
> 1. The Grafana Service is **ClusterIP**, so the only path in is cloudflared.
> 2. `GF_AUTH_PROXY_WHITELIST` is the pod CIDR (`10.244.0.0/16`), so Grafana
>    accepts the header only from in-cluster sources.
>
> **Adding a LoadBalancer/MetalLB IP or a NodePort to the Grafana Service breaks
> the auth model, and it breaks it silently** — no error, no log line. Anyone on
> the LAN could then send `Cf-Access-Authenticated-User-Email: whoever@…` and be
> auto-signed-up as an Admin. If you need another path to Grafana, add another
> Access-fronted route, never another Service type.

---

## 3. Retention and volume sizing

Both stores are bounded on purpose: `local-path` carves out of the node's root
disk, and a full root disk takes the **cluster** down, not just the store that
filled it.

| | retention | PVC | why bounded |
|---|-----------|-----|-------------|
| Prometheus | `15d` (`--storage.tsdb.retention.time`) | 30Gi | retention is the soft bound, the PVC is the hard one |
| Loki | `336h` (14d, `limits_config.retention_period`) | 30Gi | plus ingestion + per-stream rate limits, so one crash-looping pod's stack traces cannot fill the disk |
| Grafana | n/a | 5Gi | only SQLite/session/plugin cache — dashboards and datasources come from ConfigMaps |

Loki's retention is **not self-executing**: `retention_period` alone only stops
queries returning old data. The compactor is what deletes chunks, which is why
`compactor.retention_enabled: true` and `delete_request_store: filesystem` are
both set. Remove either and the PVC fills while queries look correct.

Ingestion is capped at 16 MB/s (32 MB burst), 8 MB/s per stream, 10k streams,
256KB lines (truncated, not dropped). Samples older than 24h are rejected — an
out-of-order-by-a-week sample means a clock-skewed collector, and accepting it
corrupts index ordering.

Loki runs monolithic on the filesystem with `auth_enabled: false` (single `fake`
tenant), tsdb index at schema `v13`. The microservices modes exist to scale reads
and writes across many machines, which this cluster will never do.

---

## 4. How to add a dashboard

Dashboards in git are the source of truth. Steps:

1. **Vendor the JSON** into `infra/observability/dashboards/<name>.json`.
2. **Rewrite every datasource reference** to the stack's UIDs:
   `www-prometheus` for Prometheus, `www-loki` for Loki. A vendored dashboard
   from grafana.com usually carries a `${DS_PROMETHEUS}` input or a foreign UID;
   both render an empty dashboard here.
3. **Give it a unique, stable `uid`** at the top level (ours are prefixed `www-`:
   `www-k8s-cluster`, `www-node-exporter`, `www-cnpg-postgres`, …). A duplicate
   uid makes one dashboard shadow the other.
4. Deploy. `installDashboardConfigMaps()` globs the directory and emits **one
   ConfigMap per file** (a ConfigMap is capped at ~1 MiB by etcd and a single
   dashboard routinely runs to hundreds of KiB, so a combined ConfigMap would
   work right up until it didn't). Invalid JSON throws at `pulumi preview`, not
   silently at Grafana boot.

**UI edits cannot be saved.** The file provider runs with `allowUiUpdates: false`
and `disableDeletion: true`, so a dashboard edited in the browser is reverted on
the next provisioning sweep (30s). That is deliberate: it is what keeps the
checked-in JSON the only way a dashboard changes, and it means recreating the
Grafana PVC loses nothing. To iterate, edit in the browser, use the panel's
**JSON Model** / dashboard export to copy the result out, and commit that.

Currently vendored: cluster and namespace compute resources, node-exporter
nodes, persistent-volume usage, CloudNativePG/Postgres.

---

## 5. How to add a metric to an App

Two halves: emit it, then get it scraped.

### Emit — `@www/platform/metrics`

One registry for every backend runtime (#214). No service constructs its own
`Registry`, `Counter`, `Gauge` or `Histogram` — same rule as the sound bus and
the env registry. Every metric name is `www_`-prefixed; everything else on the
endpoint is prom-client's own process/runtime collection.

At boot:

```ts
import { initMetrics, startMetricsServer } from "@www/platform/metrics";

initMetrics({ service: "worker" }); // stamped on every series as `service`
startMetricsServer({ port: config.METRICS_PORT, logger });
```

`initMetrics` is idempotent (the api's second entrypoint, the guest listener, is
safe). `metricsHandler()` returns a web-standard `Response` if you would rather
serve it from an existing `Bun.serve` route — but see the security note below
before doing that on a publicly-routed port.

Observations go through the typed helpers rather than raw metric objects:

- `observeHttpRequest()` — `www_http_requests_total`,
  `www_http_request_errors_total`, `www_http_request_duration_seconds`, labelled
  `method` / `route` / `status_class`. `route` is a route **template** or a tRPC
  procedure name, never a raw pathname.
- `observeJobRun()` — `www_job_runs_total`, `www_job_failures_total`,
  `www_job_duration_seconds`, labelled by job **type**. Wired into `claimOne` in
  `@www/core`'s job queue.
- `observeCronRun()` — the cron equivalent, labelled by cron **name**.

Every label value passes through `boundedLabel`, which folds anything past 200
distinct values per key into `other`. That is a backstop, not a licence: a
request id, job row id or user id in a label allocates one series per value and
is the fastest way to OOM the TSDB. A large `other` bucket on a dashboard means
some caller is labelling with something unbounded.

The listener is a **dedicated port** (`DEFAULT_METRICS_PORT` = 9464, path
`/metrics`), not a route on an existing server. That is a security boundary: the
api's `:4201` is mapped through the Cloudflare tunnel, so a `/metrics` route
there would put the process's full internal state on the public internet.

### Scrape — `scrape: { port }` on the WorkloadSpec

In `infra/src/services.ts`:

```ts
{
  name: "worker",
  // …
  scrape: { port: DEFAULT_METRICS_PORT }, // path defaults to "/metrics"
}
```

This renders `prometheus.io/scrape`, `prometheus.io/port` and
`prometheus.io/path` onto the **pod template**, and the `kubernetes-pods` scrape
job picks it up.

Three things worth knowing:

- **It is NOT the same as `annotations`.** `WorkloadSpec.annotations` goes on the
  *Deployment's* metadata (that is where the provider's `pulumi.com/*`
  await-control keys belong). Prometheus's `role: pod` service discovery only
  ever sees Pod objects, so an annotation that lands on the Deployment is
  invisible to it and discovery silently finds nothing.
- **`port` is required**, not optional. Prometheus 3.x no longer appends a
  default port to a discovered address, so `prometheus.io/scrape: "true"` with no
  port resolves to a bare pod IP and the target fails. Requiring it means the
  annotation set is never half-declared.
- **Do not add the metrics port to `ports`.** Scraping is pod-IP direct and needs
  no Service; anything in `ports` becomes a Service and, for the api, reachable
  through the tunnel.

No Service, no ServiceMonitor, no central list of targets — the workload's
monitoring is declared next to the workload (ADR-0001).

---

## 6. How to query logs

Grafana → Explore → **Loki** datasource. Every container in the cluster is
collected, including third-party images.

The label set is exactly:

| label | source |
|-------|--------|
| `namespace` | pod's namespace |
| `pod` | pod name |
| `container` | container name |
| `app` | `app.kubernetes.io/name` or `app` pod label, best-effort |
| `service` | pino's `service` base field (api, worker, temporal-worker, …) |
| `level` | pino's numeric `level`, mapped to `trace`/`debug`/`info`/`warn`/`error`/`fatal` |

```logql
{namespace="control-center", service="api", level="error"}
{namespace="control-center", service="worker"} | json | msg =~ "job .*"
```

Non-JSON lines from third-party images extract nothing and fall through
unlabelled — they are still there, just without `service`/`level`.

> **Never add an unbounded label.** Every distinct combination of label *values*
> is a separate Loki stream with its own index entry and its own chunks. A
> request id, trace id, user id, session id, URL path or error message as a label
> means one stream per request: the index explodes, the ingester holds thousands
> of tiny open chunks, and queries that took a second start timing out. It is not
> recoverable without deleting data.
>
> Those fields are still queryable. They stay in the JSON line — filter them at
> query time with `| json` — or attach them as structured metadata
> (`stage.structured_metadata`; `allow_structured_metadata` is on), which is
> indexed per-chunk rather than per-stream. **Filter, do not label.**

Timestamps come from the application's own `time` field, so a backlogged
collector does not stamp an hour-old line with the time it was read.

Frontend/panel logs are a **separate** pipeline and are not in Loki — they ship
to Postgres (`frontend_log`). See `docs/logging.md`.

---

## 7. What is deliberately not monitored

**Control-plane components.** kube-scheduler, kube-controller-manager, kube-proxy
and etcd all bind to `127.0.0.1` on Talos. A scrape job for any of them would sit
permanently DOWN and drag the mixin's "cluster components" panels red, so there
is no job for them. Do not "fix" this by opening the bind addresses in
`talconfig.yaml`: changing them needs a node reboot, and with a single
control-plane node that is full cluster downtime — in exchange for an
unauthenticated metrics endpoint on the LAN.

**Alerting — there is none, anywhere.** No Alertmanager, no alerting rules, no
Loki ruler. The vendored mixin's alert rules are stripped; only recording rules
are kept. This is a decision (#33), not an omission: the stack is for looking at
things when something is already wrong. A Loki ruler with no rule storage
configured would also log an error on every evaluation cycle, which is why the
`ruler` block is absent rather than empty.

**Kubelet TLS is not verified.** Talos's kubelet serving cert is self-signed, so
scrapes run `insecure_skip_verify` — the same reason metrics-server already runs
`--kubelet-insecure-tls`.

---

## 8. Load-bearing names

Two sets of strings look like free-form identifiers and are not.

**Scrape job names.** The vendored kubernetes-mixin recording rules select on
these literals:

- `kubelet`
- `cadvisor` — *not* `kubernetes-cadvisor`; the mixin's container rules match
  `job="cadvisor"` exactly
- `kube-state-metrics`
- `node-exporter` — the DaemonSet's Service name and its
  `app.kubernetes.io/name` label are pinned to this for the same reason

Renaming one does not break the scrape. The target stays green, the series keep
arriving, and **every mixin-derived dashboard panel silently empties**.

**Datasource UIDs.** `www-prometheus` and `www-loki` are hardcoded constants, not
Grafana-generated. Every vendored dashboard selects its datasource by UID, so a
generated UID would break the whole set the first time the Grafana PVC was
recreated. Changing either constant empties every dashboard, again with no error.

Two more relabel details in the same category: the node-exporter job rewrites
`instance` to the **node name** (the mixin's `node.rules` join node-exporter
series to kube-state-metrics series on `instance` and expect a node name; left at
the scraped address the joins produce nothing), and the CNPG job writes
`cluster_name`, never `cluster` — `cluster` is the global external label
(`home-server`) that every mixin dashboard's cluster variable reads.

---

## 9. How the vendored rules were produced

`infra/observability/rules/*.yaml` are plain Prometheus `groups:` files mounted
at `/etc/prometheus/rules` and globbed by `rule_files`. They exist because the
standard Kubernetes dashboards do not query raw metrics — they query recording
rules like
`node_namespace_pod_container:container_cpu_usage_seconds_total:sum_rate5m`.
Without them the dashboards render empty, with no error anywhere.

They were extracted from kube-prometheus's checked-in `PrometheusRule`
manifests:

1. Take the `PrometheusRule` manifest.
2. Keep **`.spec` only** — that is already a `groups:` document, which is the
   mixin's native output. The CRD is the derived form, which is why no operator
   is needed (#207).
3. **Strip all alerting rules**; keep `record:` rules only (§7 — no alerting).
4. Rewrite `job="kubelet", metrics_path="/metrics/cadvisor"` to `job="cadvisor"`,
   matching this stack's split of kubelet and cadvisor into two jobs.

Repeat those four steps against the new upstream version to upgrade. Prometheus
runs with `--web.enable-lifecycle`, so a rules change can be applied with
`POST /-/reload` instead of deleting the pod (which, with `Recreate` + a RWO
volume, means a gap in scraping).

---

## 10. Related

- `infra/src/observability/` — the Pulumi program, one file per component. The
  header comment in each file carries the reasoning for that component.
- `infra/observability/` — vendored dashboard JSON and recording rules.
- `packages/platform/metrics/` — the `@www/platform/metrics` primitive.
- `docs/logging.md` — the pino logging contract and the frontend log pipeline.

## Known gap: local-path volumes report no PVC usage

`kubelet_volume_stats_*` — what the Kubernetes / Persistent Volumes dashboard is built on — is
only emitted for volumes the kubelet tracks that way. On this cluster that means the three
NFS-backed PVCs in `control-center`; the `local-path` PVCs (`maps`, `plex-config`, `ha-config`
and the three CNPG data volumes) report nothing, because local-path is a hostPath directory
rather than a real volume plugin.

So that dashboard covers NFS only. Headroom for everything on local-path is the node filesystem
panels on Node Exporter / Nodes instead — which is the number that actually matters here, since
every local-path PVC shares the node's single disk and none of them are quota-enforced. A PVC's
declared size is documentation, not a limit.
