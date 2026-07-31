import "./boot-env";
import { createLogger, installFatalHandlers } from "@www/logger";
import { ENV } from "@www/platform/env";
import { initMetrics, startMetricsServer } from "@www/platform/metrics";
import { relayConfig } from "./config";
import { createRelay } from "./relay";

const log = createLogger({ service: "webhook-relay" });
installFatalHandlers(log);
initMetrics({ service: "webhook-relay" });
startMetricsServer({ port: ENV.METRICS_PORT, logger: log });
const handler = createRelay({ ...relayConfig(), logger: log });
Bun.serve({ port: ENV.PORT, fetch: handler });
log.info({ port: ENV.PORT }, "webhook relay listening");
