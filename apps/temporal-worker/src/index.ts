/**
 * The Temporal worker: polls the `main` task queue in the `control-center`
 * namespace, serving HealthCheckWorkflow + HealthCheckActivity.
 *
 * This is the one runtime in the repo that runs on NODE rather than bun —
 * @temporalio/core-bridge is a native addon published for glibc Node only, and
 * the Workflow sandbox is built on node's `vm`. See the Dockerfile.
 */

import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createLogger } from "@www/logger";
import * as activities from "./activities";
import { temporalWorkerConfig } from "./config";
import { upsertHealthCheckSchedule } from "./schedule";

const logger = createLogger({ service: "temporal-worker" });

// workflows.ts is shipped as SOURCE and handed to the SDK's own bundler at boot
// (it enforces the determinism sandbox), so this is a path, not an import. It
// resolves next to this module in both the image (/app/src) and local dev.
const workflowsPath = new URL("./workflows.ts", import.meta.url).pathname;

async function main(): Promise<void> {
  const config = temporalWorkerConfig();
  logger.info(
    {
      address: config.address,
      namespace: config.namespace,
      taskQueue: config.taskQueue,
      iterations: config.healthCheckIterations,
    },
    "temporal worker starting",
  );

  // Two connections on purpose: the Worker needs the Rust bridge's
  // NativeConnection, while the schedule upsert speaks the plain gRPC client.
  const connection = await NativeConnection.connect({ address: config.address });
  const clientConnection = await Connection.connect({ address: config.address });
  const client = new Client({ connection: clientConnection, namespace: config.namespace });

  // Upsert BEFORE run(): if the schedule cannot be written the deploy should
  // fail loudly here, not come up green with nothing ever being scheduled.
  await upsertHealthCheckSchedule({
    client,
    taskQueue: config.taskQueue,
    iterations: config.healthCheckIterations,
    logger,
  });

  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowsPath,
    activities,
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
