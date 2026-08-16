import { readFileSync } from "node:fs";
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
  readonly apnsKeyId: string;
  readonly apnsTeamId: string;
  readonly apnsKeyContent: string;
  readonly pushTokenKeyring: string;
}

type RawTemporalWorkerConfig = {
  readonly TEMPORAL_ADDRESS: string;
  readonly TEMPORAL_NAMESPACE: string;
  readonly TEMPORAL_TASK_QUEUE: string;
  readonly DATABASE_URL: string;
  readonly METRICS_PORT: number;
  readonly TEMPORAL_OTEL_COLLECTOR_URL: string;
  readonly APNS_KEY_ID?: string;
  readonly APNS_TEAM_ID?: string;
  readonly APNS_KEY_CONTENT?: string;
  readonly PUSH_TOKEN_KEYRING?: string;
};

export function parseTemporalWorkerConfig(env: RawTemporalWorkerConfig): TemporalWorkerConfig {
  if (env.TEMPORAL_NAMESPACE !== DTYE_TEMPORAL_NAMESPACE) {
    throw new Error(`Don't Text Your Ex Temporal namespace must be ${DTYE_TEMPORAL_NAMESPACE}`);
  }
  if (env.TEMPORAL_TASK_QUEUE !== DTYE_TEMPORAL_TASK_QUEUE) {
    throw new Error(`Don't Text Your Ex Temporal task queue must be ${DTYE_TEMPORAL_TASK_QUEUE}`);
  }
  if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_KEY_CONTENT || !env.PUSH_TOKEN_KEYRING) {
    throw new Error("Don't Text Your Ex notification delivery secrets must be configured");
  }
  return {
    address: env.TEMPORAL_ADDRESS,
    namespace: DTYE_TEMPORAL_NAMESPACE,
    taskQueue: DTYE_TEMPORAL_TASK_QUEUE,
    databaseUrl: env.DATABASE_URL,
    metricsPort: env.METRICS_PORT,
    otelCollectorUrl: env.TEMPORAL_OTEL_COLLECTOR_URL,
    apnsKeyId: env.APNS_KEY_ID,
    apnsTeamId: env.APNS_TEAM_ID,
    apnsKeyContent: env.APNS_KEY_CONTENT,
    pushTokenKeyring: env.PUSH_TOKEN_KEYRING,
  };
}

export function temporalWorkerConfig(): TemporalWorkerConfig {
  const env = ENV.pick(
    "TEMPORAL_ADDRESS",
    "TEMPORAL_NAMESPACE",
    "TEMPORAL_TASK_QUEUE",
    "DATABASE_URL",
    "METRICS_PORT",
    "TEMPORAL_OTEL_COLLECTOR_URL",
    "APNS_KEY_ID",
    "APNS_TEAM_ID",
    "APNS_KEY_CONTENT",
    "PUSH_TOKEN_KEYRING",
  );
  const secretFile = (name: string): string | undefined => {
    try {
      return readFileSync(`/run/notification-secrets/${name}`, "utf-8").trim();
    } catch {
      return undefined;
    }
  };
  return parseTemporalWorkerConfig({
    ...env,
    APNS_KEY_ID: env.APNS_KEY_ID ?? secretFile("APNS_KEY_ID"),
    APNS_TEAM_ID: env.APNS_TEAM_ID ?? secretFile("APNS_TEAM_ID"),
    APNS_KEY_CONTENT: env.APNS_KEY_CONTENT ?? secretFile("APNS_KEY_CONTENT"),
    PUSH_TOKEN_KEYRING: env.PUSH_TOKEN_KEYRING ?? secretFile("PUSH_TOKEN_KEYRING"),
  });
}
