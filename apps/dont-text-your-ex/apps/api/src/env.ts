import { readFileSync } from "node:fs";
import { __resetEnvCache, defineEnv, enumOf, int, pgUrl, str } from "@www/platform/env";

const ENV = defineEnv({
  APP_ENV: enumOf("development", "production", "test").default("development"),
  PORT: int().default(8787),
  DATABASE_URL: pgUrl().optional(),
  POSTGRES_PASSWORD_FILE: str().default("/run/secrets/POSTGRES_PASSWORD"),
  POSTGRES_HOST: str().default("localhost"),
  POSTGRES_PORT: str().default("5432"),
  POSTGRES_USER: str().default("postgres"),
  // Preserve the historical database name so a restored deployment can attach
  // to its existing data rather than silently provisioning an empty database.
  POSTGRES_DB: str().default("text_your_ex"),
  APPLE_BUNDLE_ID: str().default("co.worldwidewebb.textyourex"),
  TEMPORAL_ADDRESS: str().optional(),
  PUSH_TOKEN_KEYRING_FILE: str().default("/run/secrets/PUSH_TOKEN_KEYRING"),
  PUSH_TOKEN_KEYRING: str().optional(),
  ACCOUNT_DELETION_KEYRING_FILE: str().default("/run/secrets/ACCOUNT_DELETION_KEYRING"),
  ACCOUNT_DELETION_KEYRING: str().optional(),
  RESTORE_TOMBSTONE_HMAC_KEYRING_FILE: str().default(
    "/run/account-deletion-secrets/RESTORE_TOMBSTONE_HMAC_KEYRING",
  ),
  RESTORE_TOMBSTONE_HMAC_KEYRING: str().optional(),
  RESTORE_TOMBSTONE_SIGNING_KEYRING_FILE: str().default(
    "/run/account-deletion-secrets/RESTORE_TOMBSTONE_SIGNING_KEYRING",
  ),
  RESTORE_TOMBSTONE_SIGNING_KEYRING: str().optional(),
  ERASURE_JOURNAL_DIR: str().optional(),
  DTYE_RESTORE_MODE: str().optional(),
  DTYE_RESTORE_TRAFFIC_DISABLED: str().optional(),
  TYE_RESET: str().optional(),
});

// Build DATABASE_URL from an explicit value (local development/tests) or the
// password file mounted by External Secrets in production.
export function buildDatabaseUrl(): string | undefined {
  if (ENV.DATABASE_URL) return ENV.DATABASE_URL;
  let password: string;
  try {
    password = readFileSync(ENV.POSTGRES_PASSWORD_FILE, "utf-8").trim();
  } catch {
    return undefined;
  }
  if (!password) return undefined;
  return `postgresql://${ENV.POSTGRES_USER}:${encodeURIComponent(password)}@${ENV.POSTGRES_HOST}:${ENV.POSTGRES_PORT}/${ENV.POSTGRES_DB}`;
}

export function appleBundleId(): string {
  return ENV.APPLE_BUNDLE_ID;
}

export function temporalAddress(): string | undefined {
  return ENV.TEMPORAL_ADDRESS;
}

export function pushTokenKeyringSource(): unknown {
  try {
    return JSON.parse(ENV.PUSH_TOKEN_KEYRING ?? readFileSync(ENV.PUSH_TOKEN_KEYRING_FILE, "utf-8"));
  } catch (error) {
    if (ENV.APP_ENV !== "production") {
      return { activeKeyId: "local", keys: { local: Buffer.alloc(32, 7).toString("base64") } };
    }
    throw new Error("Don't Text Your Ex: PUSH_TOKEN_KEYRING_FILE must contain valid JSON", {
      cause: error,
    });
  }
}

export function accountDeletionKeyringSource(): unknown {
  try {
    return JSON.parse(
      ENV.ACCOUNT_DELETION_KEYRING ?? readFileSync(ENV.ACCOUNT_DELETION_KEYRING_FILE, "utf-8"),
    );
  } catch (error) {
    if (ENV.APP_ENV !== "production") {
      return { activeKeyId: "local", keys: { local: Buffer.alloc(32, 11).toString("base64") } };
    }
    throw new Error("Don't Text Your Ex: ACCOUNT_DELETION_KEYRING_FILE must contain valid JSON", {
      cause: error,
    });
  }
}

function restoreTombstoneKeyringSource(
  inline: string | undefined,
  file: string,
  fallbackByte: number,
  label: string,
): unknown {
  try {
    return JSON.parse(inline ?? readFileSync(file, "utf-8"));
  } catch (error) {
    if (ENV.APP_ENV !== "production") {
      return {
        activeKeyId: "local",
        keys: { local: Buffer.alloc(32, fallbackByte).toString("base64") },
      };
    }
    throw new Error(`Don't Text Your Ex: ${label} must contain valid JSON`, { cause: error });
  }
}

export function restoreTombstoneHmacKeyringSource(): unknown {
  return restoreTombstoneKeyringSource(
    ENV.RESTORE_TOMBSTONE_HMAC_KEYRING,
    ENV.RESTORE_TOMBSTONE_HMAC_KEYRING_FILE,
    12,
    "RESTORE_TOMBSTONE_HMAC_KEYRING_FILE",
  );
}

export function restoreTombstoneSigningKeyringSource(): unknown {
  return restoreTombstoneKeyringSource(
    ENV.RESTORE_TOMBSTONE_SIGNING_KEYRING,
    ENV.RESTORE_TOMBSTONE_SIGNING_KEYRING_FILE,
    13,
    "RESTORE_TOMBSTONE_SIGNING_KEYRING_FILE",
  );
}

export function erasureJournalDirectory(): string {
  if (ENV.ERASURE_JOURNAL_DIR) return ENV.ERASURE_JOURNAL_DIR;
  if (ENV.APP_ENV === "production") {
    throw new Error("Don't Text Your Ex: ERASURE_JOURNAL_DIR must be configured in production");
  }
  return "/tmp/dont-text-your-ex-erasure-journal";
}

export function isolatedRestoreReplayConfig(): {
  readonly hmacKeyringFile: string;
  readonly signingKeyringFile: string;
  readonly journalDirectory: string;
} {
  if (ENV.DTYE_RESTORE_MODE !== "isolated-scratch") {
    throw new Error("restore replay refuses to run outside isolated-scratch mode");
  }
  if (ENV.DTYE_RESTORE_TRAFFIC_DISABLED !== "true") {
    throw new Error("restore replay requires application traffic to be disabled");
  }
  if (!ENV.ERASURE_JOURNAL_DIR) {
    throw new Error("restore replay requires ERASURE_JOURNAL_DIR");
  }
  return {
    hmacKeyringFile: ENV.RESTORE_TOMBSTONE_HMAC_KEYRING_FILE,
    signingKeyringFile: ENV.RESTORE_TOMBSTONE_SIGNING_KEYRING_FILE,
    journalDirectory: ENV.ERASURE_JOURNAL_DIR,
  };
}

export function requireDatabaseUrl(): string {
  const url = buildDatabaseUrl();
  if (!url) {
    throw new Error(
      "Don't Text Your Ex: DATABASE_URL or POSTGRES_PASSWORD_FILE must be set. " +
        "For local dev set DATABASE_URL=postgresql://postgres:password@localhost:5432/text_your_ex",
    );
  }
  return url;
}

export function isProduction(): boolean {
  return ENV.APP_ENV === "production";
}

export function shouldResetDatabase(): boolean {
  return ENV.TYE_RESET === "1" && !isProduction();
}

export function apiPort(): number {
  return ENV.PORT;
}

export function resetEnvCache(): void {
  __resetEnvCache(ENV);
}
