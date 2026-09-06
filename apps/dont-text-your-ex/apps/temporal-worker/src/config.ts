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
  readonly siwaKeyId: string;
  readonly siwaTeamId: string;
  readonly siwaKeyContent: string;
  readonly appleBundleId: string;
  readonly accountDeletionKeyring: string;
  readonly restoreTombstoneHmacKeyring: string;
  readonly restoreTombstoneSigningKeyring: string;
  readonly erasureJournalDirectory: string;
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
  readonly SIWA_KEY_ID?: string;
  readonly SIWA_TEAM_ID?: string;
  readonly SIWA_KEY_CONTENT?: string;
  readonly APPLE_BUNDLE_ID?: string;
  readonly ACCOUNT_DELETION_KEYRING?: string;
  readonly RESTORE_TOMBSTONE_HMAC_KEYRING?: string;
  readonly RESTORE_TOMBSTONE_SIGNING_KEYRING?: string;
  readonly ERASURE_JOURNAL_DIR?: string;
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
  if (
    !env.SIWA_KEY_ID ||
    !env.SIWA_TEAM_ID ||
    !env.SIWA_KEY_CONTENT ||
    !env.APPLE_BUNDLE_ID ||
    !env.ACCOUNT_DELETION_KEYRING ||
    !env.RESTORE_TOMBSTONE_HMAC_KEYRING ||
    !env.RESTORE_TOMBSTONE_SIGNING_KEYRING ||
    !env.ERASURE_JOURNAL_DIR
  ) {
    throw new Error("Don't Text Your Ex account deletion secrets must be configured");
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
    siwaKeyId: env.SIWA_KEY_ID,
    siwaTeamId: env.SIWA_TEAM_ID,
    siwaKeyContent: env.SIWA_KEY_CONTENT,
    appleBundleId: env.APPLE_BUNDLE_ID,
    accountDeletionKeyring: env.ACCOUNT_DELETION_KEYRING,
    restoreTombstoneHmacKeyring: env.RESTORE_TOMBSTONE_HMAC_KEYRING,
    restoreTombstoneSigningKeyring: env.RESTORE_TOMBSTONE_SIGNING_KEYRING,
    erasureJournalDirectory: env.ERASURE_JOURNAL_DIR,
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
    "SIWA_KEY_ID",
    "SIWA_TEAM_ID",
    "SIWA_KEY_CONTENT",
    "APPLE_BUNDLE_ID",
    "ACCOUNT_DELETION_KEYRING",
    "RESTORE_TOMBSTONE_HMAC_KEYRING",
    "RESTORE_TOMBSTONE_SIGNING_KEYRING",
    "ERASURE_JOURNAL_DIR",
  );
  const secretFile = (name: string): string | undefined => {
    try {
      return readFileSync(`/run/notification-secrets/${name}`, "utf-8").trim();
    } catch {
      return undefined;
    }
  };
  const accountDeletionSecretFile = (name: string): string | undefined => {
    try {
      return readFileSync(`/run/account-deletion-secrets/${name}`, "utf-8").trim();
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
    SIWA_KEY_ID: env.SIWA_KEY_ID ?? accountDeletionSecretFile("SIWA_KEY_ID"),
    SIWA_TEAM_ID: env.SIWA_TEAM_ID ?? accountDeletionSecretFile("SIWA_TEAM_ID"),
    SIWA_KEY_CONTENT: env.SIWA_KEY_CONTENT ?? accountDeletionSecretFile("SIWA_KEY_CONTENT"),
    APPLE_BUNDLE_ID: env.APPLE_BUNDLE_ID ?? "co.worldwidewebb.textyourex",
    ACCOUNT_DELETION_KEYRING:
      env.ACCOUNT_DELETION_KEYRING ?? accountDeletionSecretFile("ACCOUNT_DELETION_KEYRING"),
    RESTORE_TOMBSTONE_HMAC_KEYRING:
      env.RESTORE_TOMBSTONE_HMAC_KEYRING ??
      accountDeletionSecretFile("RESTORE_TOMBSTONE_HMAC_KEYRING"),
    RESTORE_TOMBSTONE_SIGNING_KEYRING:
      env.RESTORE_TOMBSTONE_SIGNING_KEYRING ??
      accountDeletionSecretFile("RESTORE_TOMBSTONE_SIGNING_KEYRING"),
    ERASURE_JOURNAL_DIR: env.ERASURE_JOURNAL_DIR,
  });
}
