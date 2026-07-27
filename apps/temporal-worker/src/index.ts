/**
 * The Temporal worker: polls the `main` task queue in the `control-center`
 * namespace, serving every workflow/activity the features declare through
 * their temporal facets (ADR-0008) — registration and Schedules both come from
 * `features/_generated/`, zero per-feature hand-wiring here.
 *
 * This is the one runtime in the repo that runs on NODE rather than bun —
 * @temporalio/core-bridge is a native addon published for glibc Node only, and
 * the Workflow sandbox is built on node's `vm`. See the Dockerfile.
 */

import "./boot-env";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Runtime, Worker } from "@temporalio/worker";
import { createLogger } from "@www/logger";
import { initMetrics, startMetricsServer } from "@www/platform/metrics";
import { GENERATED_ACTIVITIES } from "../../../features/_generated/activities.gen";
import { GENERATED_SCHEDULES } from "../../../features/_generated/schedules.gen";
import { temporalWorkerConfig } from "./config";
import { reconcileSchedules } from "./reconcile";

const logger = createLogger({ service: "temporal-worker" });

// The generated workflows barrel is shipped as SOURCE and handed to the SDK's
// own bundler at boot (it enforces the determinism sandbox), so this is a
// path, not an import. The image mirrors the repo layout
// (apps/temporal-worker/src ↔ features/), so the relative hop resolves
// identically in the container and local dev.
const workflowsPath = new URL("../../../features/_generated/workflows.gen.ts", import.meta.url)
  .pathname;

async function main(): Promise<void> {
  const config = temporalWorkerConfig();

  // Prometheus exposition on a dedicated port (#214). This process otherwise
  // serves no HTTP — it dials OUT to temporal-server:7233 — so the listener
  // exists only for scraping. No Kubernetes Service fronts it: Prometheus
  // reaches the pod IP directly via the pod annotations on the Deployment in
  // infra/src/temporal.ts, which keeps it in-cluster only.
  initMetrics({ service: "temporal-worker" });
  startMetricsServer({ port: config.metricsPort, logger });

  // SDK-internal metrics (workflow/activity completions, schedule-to-start,
  // sticky-cache hit rate, poller counts — #233), entirely separate from the
  // app-level listener above: this is Core's own OTel exporter, sent to a
  // small in-cluster collector that re-exports it to Prometheus. Must be set
  // before Worker.create() — it configures the process-wide Runtime the
  // Worker then picks up.
  Runtime.install({ telemetryOptions: { metrics: { otel: { url: config.otelCollectorUrl } } } });

  logger.info(
    {
      address: config.address,
      namespace: config.namespace,
      taskQueue: config.taskQueue,
      schedules: GENERATED_SCHEDULES.length,
    },
    "temporal worker starting",
  );

  // Two connections on purpose: the Worker needs the Rust bridge's
  // NativeConnection, while the schedule reconciler speaks the plain gRPC client.
  const connection = await NativeConnection.connect({ address: config.address });
  const clientConnection = await Connection.connect({ address: config.address });
  const client = new Client({ connection: clientConnection, namespace: config.namespace });

  // Reconcile BEFORE run(): if the schedule set cannot be written the deploy
  // should fail loudly here, not come up green with nothing ever scheduled.
  await reconcileSchedules({
    client,
    taskQueue: config.taskQueue,
    schedules: GENERATED_SCHEDULES,
    logger,
  });

  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowsPath,
    activities: GENERATED_ACTIVITIES,
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "temporal worker shutting down");
    worker.shutdown();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await worker.run();
  await clientConnection.close();
  await connection.close();
  logger.info("temporal worker stopped");
}

main().catch((error) => {
  logger.error({ err: error }, "temporal worker failed");
  process.exit(1);
});
