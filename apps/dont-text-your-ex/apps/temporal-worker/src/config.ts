import { ENV } from "@www/platform/env";

const DTYE_TEMPORAL_NAMESPACE = "dont-text-your-ex" as const;
const DTYE_TEMPORAL_TASK_QUEUE = "main" as const;

export interface TemporalWorkerConfig {
  readonly address: string;
  readonly namespace: typeof DTYE_TEMPORAL_NAMESPACE;
  readonly taskQueue: typeof DTYE_TEMPORAL_TASK_QUEUE;
  readonly databaseUrl: string;
  readonly metricsPort: number;
  readonly otelCollectorUrl: string;
}

type RawTemporalWorkerConfig = {
  readonly TEMPORAL_ADDRESS: string;
  readonly TEMPORAL_NAMESPACE: string;
  readonly TEMPORAL_TASK_QUEUE: string;
  readonly DATABASE_URL: string;
  readonly METRICS_PORT: number;
  readonly TEMPORAL_OTEL_COLLECTOR_URL: string;
};

export function parseTemporalWorkerConfig(env: RawTemporalWorkerConfig): TemporalWorkerConfig {
  if (env.TEMPORAL_NAMESPACE !== DTYE_TEMPORAL_NAMESPACE) {
    throw new Error(`Don't Text Your Ex Temporal namespace must be ${DTYE_TEMPORAL_NAMESPACE}`);
  }
  if (env.TEMPORAL_TASK_QUEUE !== DTYE_TEMPORAL_TASK_QUEUE) {
    throw new Error(`Don't Text Your Ex Temporal task queue must be ${DTYE_TEMPORAL_TASK_QUEUE}`);
  }
  return {
    address: env.TEMPORAL_ADDRESS,
    namespace: DTYE_TEMPORAL_NAMESPACE,
    taskQueue: DTYE_TEMPORAL_TASK_QUEUE,
    databaseUrl: env.DATABASE_URL,
    metricsPort: env.METRICS_PORT,
    otelCollectorUrl: env.TEMPORAL_OTEL_COLLECTOR_URL,
  };
}

export function temporalWorkerConfig(): TemporalWorkerConfig {
  return parseTemporalWorkerConfig(
    ENV.pick(
      "TEMPORAL_ADDRESS",
      "TEMPORAL_NAMESPACE",
      "TEMPORAL_TASK_QUEUE",
      "DATABASE_URL",
      "METRICS_PORT",
      "TEMPORAL_OTEL_COLLECTOR_URL",
    ),
  );
}
