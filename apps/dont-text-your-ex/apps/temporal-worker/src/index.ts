import "./boot-env";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Runtime, Worker } from "@temporalio/worker";
import { createLogger } from "@www/logger";
import { initMetrics, startMetricsServer } from "@www/platform/metrics";
import { reconcileSchedules, temporalScheduleGateway } from "@www/temporal-runtime";
import { temporalWorkerConfig } from "./config";
import { createWorkerLifecycle } from "./lifecycle";
import { ACTIVITIES, MANAGED_SCHEDULE_PREFIX, SCHEDULES } from "./registry";

const logger = createLogger({ service: "dont-text-your-ex-temporal-worker" });
const workflowsPath = new URL("./workflows.ts", import.meta.url).pathname;

async function main(): Promise<void> {
  const config = temporalWorkerConfig();
  initMetrics({ service: "dont-text-your-ex-temporal-worker" });
  startMetricsServer({ port: config.metricsPort, logger });
  Runtime.install({ telemetryOptions: { metrics: { otel: { url: config.otelCollectorUrl } } } });
  logger.info(
    { address: config.address, namespace: config.namespace, taskQueue: config.taskQueue },
    "temporal worker starting",
  );
  const connection = await NativeConnection.connect({ address: config.address });
  const clientConnection = await Connection.connect({ address: config.address });
  const client = new Client({ connection: clientConnection, namespace: config.namespace });
  await reconcileSchedules({
    gateway: temporalScheduleGateway(client),
    taskQueue: config.taskQueue,
    managedPrefix: MANAGED_SCHEDULE_PREFIX,
    schedules: SCHEDULES,
    logger,
  });
  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowsPath,
    activities: ACTIVITIES,
    shutdownGraceTime: "20 seconds",
  });
  const lifecycle = createWorkerLifecycle({
    worker,
    closeClient: () => clientConnection.close(),
    closeNative: () => connection.close(),
    logger,
  });
  process.on("SIGTERM", () => lifecycle.shutdown("SIGTERM"));
  process.on("SIGINT", () => lifecycle.shutdown("SIGINT"));
  await lifecycle.run();
}

main().catch((error) => {
  logger.error({ err: error }, "temporal worker failed");
  process.exit(1);
});
