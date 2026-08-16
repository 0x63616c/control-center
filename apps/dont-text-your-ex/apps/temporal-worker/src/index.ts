import "./boot-env";
import {
  createApnsClient,
  createCachedApnsAuthorization,
  createHttp2ApnsTransport,
  createNotificationStore,
  createTokenCipher,
  parseTokenKeyring,
} from "@dont-text-your-ex/notifications";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Runtime, Worker } from "@temporalio/worker";
import { createLogger } from "@www/logger";
import { initMetrics, startMetricsServer } from "@www/platform/metrics";
import { temporalScheduleGateway } from "@www/temporal-runtime";
import { Pool } from "pg";
import { DomainTransactionRunner } from "../../api/src/domain-transaction";
import { PostgresOutbox } from "../../api/src/outbox";
import { PostgresRescueStore } from "../../api/src/rescue-store";
import { createDtyeActivities } from "./activities";
import { prepareTemporalWorker } from "./boot";
import { temporalWorkerConfig } from "./config";
import { createWorkerLifecycle } from "./lifecycle";
import { createNotificationActivities } from "./notification-activities";
import {
  PostgresOutboxOperationalSnapshotStore,
  platformDtyeOperationsObserver,
} from "./operations-observability";
import { WORKFLOW_TYPES } from "./registry";
import { PostgresReportAccountabilityStore } from "./report-accountability";
import { createRescueActivities } from "./rescue-activities";
import { PostgresSessionMaintenanceStore } from "./session-maintenance";
import { createStreakMilestoneActivities, PostgresStreakSweepStore } from "./streak-milestones";
import {
  registeredTemporalEventHandlers,
  TemporalClientWorkflowGateway,
  TemporalWorkflowDispatcher,
} from "./temporal-workflow-dispatcher";

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
  const pool = new Pool({ connectionString: config.databaseUrl });
  const apnsAuthorization = createCachedApnsAuthorization({
    keyId: config.apnsKeyId,
    teamId: config.apnsTeamId,
    keyContent: config.apnsKeyContent,
  });
  const apnsTransport = createHttp2ApnsTransport();
  const reports = new PostgresReportAccountabilityStore(pool);
  const temporalGateway = new TemporalClientWorkflowGateway(client);
  const apnsClients = {
    production: createApnsClient({
      authorization: apnsAuthorization,
      transport: apnsTransport,
      host: "https://api.push.apple.com",
      topic: "co.worldwidewebb.textyourex",
    }),
    sandbox: createApnsClient({
      authorization: apnsAuthorization,
      transport: apnsTransport,
      host: "https://api.sandbox.push.apple.com",
      topic: "co.worldwidewebb.textyourex",
    }),
  } as const;
  const activities = createDtyeActivities({
    outbox: new PostgresOutbox(pool),
    dispatcher: new TemporalWorkflowDispatcher(
      registeredTemporalEventHandlers(temporalGateway, WORKFLOW_TYPES),
    ),
    sessions: new PostgresSessionMaintenanceStore(pool),
    streakMilestones: createStreakMilestoneActivities(
      new PostgresStreakSweepStore(new DomainTransactionRunner({ pool })),
    ),
    notifications: createNotificationActivities({
      store: createNotificationStore(
        pool,
        createTokenCipher(parseTokenKeyring(JSON.parse(config.pushTokenKeyring))),
      ),
      apnsClient: (environment) => apnsClients[environment],
      logger,
    }),
    operations: platformDtyeOperationsObserver,
    outboxSnapshot: new PostgresOutboxOperationalSnapshotStore(pool),
    reports,
    rescue: createRescueActivities({ store: new PostgresRescueStore(pool) }),
  });
  const worker = await prepareTemporalWorker({
    config,
    scheduleGateway: temporalScheduleGateway(client),
    logger,
    createWorker: ({ namespace, taskQueue }) =>
      Worker.create({
        connection,
        namespace,
        taskQueue,
        workflowsPath,
        activities,
        shutdownGraceTime: "20 seconds",
      }),
  });
  const lifecycle = createWorkerLifecycle({
    worker,
    closeClient: async () => {
      await pool.end();
      await clientConnection.close();
    },
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
