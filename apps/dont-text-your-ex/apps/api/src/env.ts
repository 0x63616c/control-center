import { readFileSync } from "node:fs";

// Build DATABASE_URL from explicit env var (wins) or from a Postgres password file
// mounted at /run/secrets/POSTGRES_PASSWORD (k8s ESO pattern, same as control-center).
// Returns undefined when no DB config is present (no DATABASE_URL and no readable
// password file) so importing the db layer never throws at module load, letting
// unit suites that skip DB-integration tests load without a Postgres. The api
// entrypoint calls requireDatabaseUrl() at boot so production still fails fast.
export function buildDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const pwFile = process.env.POSTGRES_PASSWORD_FILE ?? "/run/secrets/POSTGRES_PASSWORD";
  let password: string;
  try {
    password = readFileSync(pwFile, "utf-8").trim();
  } catch {
    return undefined;
  }
  const host = process.env.POSTGRES_HOST ?? "localhost";
  const port = process.env.POSTGRES_PORT ?? "5432";
  const user = process.env.POSTGRES_USER ?? "postgres";
  const name = process.env.POSTGRES_DB ?? "text_your_ex";
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
}

// Apple bundle id used as the `aud` claim when verifying Sign In with Apple
// identity tokens. Must match the App ID registered in the Apple Developer Portal.
export function appleBundleId(): string {
  return process.env.APPLE_BUNDLE_ID ?? "co.worldwidewebb.textyourex";
}

// Boot-time guard: production must have a configured database URL. Call this from
// the api entrypoint so a misconfigured deploy fails fast instead of lazily.
export function requireDatabaseUrl(): string {
  const url = buildDatabaseUrl();
  if (!url) {
    throw new Error(
      "TYE: DATABASE_URL or POSTGRES_PASSWORD_FILE must be set. " +
        "For local dev set DATABASE_URL=postgresql://postgres:password@localhost:5432/text_your_ex",
    );
  }
  return url;
}

// Centralized APP_ENV check so the rest of the app doesn't read process.env
// directly (biome noProcessEnv); production guards go through this.
export function isProduction(): boolean {
  return process.env.APP_ENV === "production";
}
