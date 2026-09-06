import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  __resetBoundedLabels,
  __resetMetrics,
  boundedLabel,
  initMetrics,
  metricsHandler,
  metricsRegistry,
  OTHER_LABEL,
  observeCronRun,
  observeDtyeAccountDeletionErasureStuck,
  observeDtyeOutboxDispatch,
  observeDtyeOutboxRecoverySuccess,
  observeDtyeOutboxSnapshot,
  observeDtyeSessionPurge,
  observeHttpRequest,
  observeJobRun,
  startMetricsServer,
  statusClass,
} from "../metrics/index";

async function exposition(): Promise<string> {
  return await metricsRegistry.metrics();
}

/**
 * Value of the one series of `name` carrying every label fragment given.
 * Matched by fragment rather than by the whole rendered label set because
 * prom-client's default-label placement differs between counters and
 * histograms, and that ordering is not what these tests are about.
 */
function seriesValue(text: string, name: string, ...labels: string[]): number | undefined {
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${name}{`)) continue;
    if (!labels.every((l) => line.includes(l))) continue;
    return Number(line.slice(line.lastIndexOf("}") + 1).trim());
  }
  return undefined;
}

beforeEach(() => {
  __resetMetrics();
  __resetBoundedLabels();
});

afterEach(() => {
  __resetMetrics();
  __resetBoundedLabels();
});

describe("registry", () => {
  test("initMetrics stamps the service default label on every series", async () => {
    initMetrics({ service: "api", collectDefaults: false });
    observeHttpRequest({ route: "/up", method: "GET", status: 200, durationSeconds: 0.01 });
    expect(await exposition()).toContain('service="api"');
  });

  test("initMetrics is idempotent (a second entrypoint must not double-register)", () => {
    initMetrics({ service: "api", collectDefaults: false });
    expect(() => initMetrics({ service: "api", collectDefaults: false })).not.toThrow();
  });

  test("metricsHandler returns the exposition text with prom-client's content-type", async () => {
    initMetrics({ service: "worker", collectDefaults: false });
    observeJobRun({ job: "notify", outcome: "success", durationSeconds: 0.2 });
    const res = await metricsHandler();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(metricsRegistry.contentType);
    expect(await res.text()).toContain("www_job_runs_total");
  });
});

describe("http helpers", () => {
  test("status collapses to a class, and nonsense collapses to other", () => {
    expect(statusClass(204)).toBe("2xx");
    expect(statusClass(404)).toBe("4xx");
    expect(statusClass(503)).toBe("5xx");
    expect(statusClass(0)).toBe(OTHER_LABEL);
  });

  test("counts requests, latency and 5xx errors under the same labels", async () => {
    initMetrics({ service: "api", collectDefaults: false });
    observeHttpRequest({ route: "/trpc", method: "POST", status: 200, durationSeconds: 0.02 });
    observeHttpRequest({ route: "/trpc", method: "POST", status: 500, durationSeconds: 0.5 });
    const text = await exposition();
    expect(
      seriesValue(text, "www_http_requests_total", 'route="/trpc"', 'status_class="2xx"'),
    ).toBe(1);
    expect(
      seriesValue(text, "www_http_request_errors_total", 'route="/trpc"', 'status_class="5xx"'),
    ).toBe(1);
    expect(text).toContain("www_http_request_duration_seconds_bucket");
  });

  test("a 4xx is not an error, but a thrown handler is", async () => {
    initMetrics({ service: "api", collectDefaults: false });
    observeHttpRequest({ route: "/up", method: "GET", status: 404, durationSeconds: 0.001 });
    expect(await exposition()).not.toContain("www_http_request_errors_total{");
    observeHttpRequest({
      route: "/up",
      method: "GET",
      status: 200,
      durationSeconds: 0.001,
      failed: true,
    });
    expect(seriesValue(await exposition(), "www_http_request_errors_total", 'route="/up"')).toBe(1);
  });

  test("an unknown HTTP method folds into other rather than opening a series", async () => {
    initMetrics({ service: "api", collectDefaults: false });
    observeHttpRequest({ route: "/up", method: "PROPFIND", status: 405, durationSeconds: 0.001 });
    expect(await exposition()).toContain(`method="${OTHER_LABEL}"`);
  });
});

describe("job helpers", () => {
  test("a failure increments both runs and failures", async () => {
    initMetrics({ service: "worker", collectDefaults: false });
    observeJobRun({ job: "notify", outcome: "success", durationSeconds: 0.1 });
    observeJobRun({ job: "notify", outcome: "failure", durationSeconds: 0.1 });
    const text = await exposition();
    expect(seriesValue(text, "www_job_runs_total", 'job="notify"')).toBe(2);
    expect(seriesValue(text, "www_job_failures_total", 'job="notify"')).toBe(1);
  });
});

describe("cron helpers", () => {
  test("a success sets the last-success gauge to the completion time in SECONDS", async () => {
    initMetrics({ service: "worker", collectDefaults: false });
    observeCronRun({
      cron: "weather-ingest",
      outcome: "success",
      durationSeconds: 1.5,
      completedAtMs: 1_700_000_000_000,
    });
    expect(
      seriesValue(
        await exposition(),
        "www_cron_last_success_timestamp_seconds",
        'cron="weather-ingest"',
      ),
    ).toBe(1_700_000_000);
  });

  test("a failure leaves the last-success gauge untouched (the whole point of it)", async () => {
    initMetrics({ service: "worker", collectDefaults: false });
    observeCronRun({
      cron: "weather-ingest",
      outcome: "success",
      durationSeconds: 1,
      completedAtMs: 1_700_000_000_000,
    });
    observeCronRun({
      cron: "weather-ingest",
      outcome: "failure",
      durationSeconds: 1,
      completedAtMs: 1_800_000_000_000,
    });
    const text = await exposition();
    expect(
      seriesValue(text, "www_cron_last_success_timestamp_seconds", 'cron="weather-ingest"'),
    ).toBe(1_700_000_000);
    expect(seriesValue(text, "www_cron_failures_total", 'cron="weather-ingest"')).toBe(1);
  });
});

describe("DTYE Temporal helpers", () => {
  test("exports bounded outbox backlog, outcomes, queue latency and activity health", async () => {
    initMetrics({ service: "dont-text-your-ex-temporal-worker", collectDefaults: false });
    observeDtyeOutboxSnapshot({ pending: 7, oldestAgeSeconds: 91, permanentFailures: 2 });
    observeDtyeOutboxDispatch({ outcome: "retry" });
    observeDtyeOutboxDispatch({ outcome: "permanent_failure" });
    observeDtyeOutboxDispatch({ outcome: "accepted", latencySeconds: 4.2 });
    observeDtyeOutboxRecoverySuccess(1_700_000_000_000);
    observeDtyeAccountDeletionErasureStuck();
    observeDtyeSessionPurge({
      outcome: "success",
      deleted: 12,
      durationSeconds: 0.25,
      completedAtMs: 1_700_000_001_000,
    });
    const text = await exposition();
    expect(seriesValue(text, "www_dtye_outbox_pending")).toBe(7);
    expect(seriesValue(text, "www_dtye_outbox_oldest_age_seconds")).toBe(91);
    expect(seriesValue(text, "www_dtye_outbox_permanent_failures")).toBe(2);
    expect(seriesValue(text, "www_dtye_outbox_dispatches_total", 'outcome="retry"')).toBe(1);
    expect(text).toContain("www_dtye_outbox_dispatch_latency_seconds_bucket");
    expect(
      seriesValue(
        text,
        "www_dtye_temporal_activity_last_success_timestamp_seconds",
        'activity="outbox_recovery"',
      ),
    ).toBe(1_700_000_000);
    expect(seriesValue(text, "www_dtye_session_purge_deleted_total")).toBe(12);
    expect(seriesValue(text, "www_dtye_account_deletion_erasure_stuck_total")).toBe(1);
    expect(text).not.toMatch(/user_id|jar_id|event_id|token=/);
  });
});

describe("label cardinality guard", () => {
  test("values beyond the limit fold into other instead of opening new series", () => {
    expect(boundedLabel("k", "a", 2)).toBe("a");
    expect(boundedLabel("k", "b", 2)).toBe("b");
    expect(boundedLabel("k", "c", 2)).toBe(OTHER_LABEL);
    // Already-seen values keep passing through once the budget is spent.
    expect(boundedLabel("k", "a", 2)).toBe("a");
  });

  test("budgets are per key, and an empty value is never a label", () => {
    expect(boundedLabel("one", "x", 1)).toBe("x");
    expect(boundedLabel("two", "y", 1)).toBe("y");
    expect(boundedLabel("one", undefined, 1)).toBe(OTHER_LABEL);
    expect(boundedLabel("one", "", 1)).toBe(OTHER_LABEL);
  });
});

describe("metrics listener", () => {
  test("serves the exposition on its own port and 404s everything else", async () => {
    initMetrics({ service: "worker", collectDefaults: false });
    observeJobRun({ job: "notify", outcome: "success", durationSeconds: 0.1 });
    // Port 0 asks the OS for a free port; the listener is dedicated and never
    // fronted by a Service, so nothing depends on a fixed number here.
    const server = startMetricsServer({ port: 0, host: "127.0.0.1" });
    try {
      let port: number | undefined;
      for (let i = 0; i < 100 && port === undefined; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        port = server.boundPort();
      }
      expect(port).toBeDefined();
      const ok = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain("www_job_runs_total");
      const missing = await fetch(`http://127.0.0.1:${port}/anything-else`);
      expect(missing.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
