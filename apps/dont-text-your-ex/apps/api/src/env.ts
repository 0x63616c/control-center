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
