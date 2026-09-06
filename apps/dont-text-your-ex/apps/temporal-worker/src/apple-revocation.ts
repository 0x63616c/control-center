import { createRemoteJWKSet, errors, importPKCS8, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import type { AppleRevocationGateway } from "./account-deletion";

const APPLE_AUTH_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_AUTH_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

export class AppleRevocationPermanentError extends Error {
  constructor(code: string) {
    super(`Apple revocation cannot be retried: ${code}`);
    this.name = "AppleRevocationPermanentError";
  }
}

export async function createAppleClientSecret(input: {
  readonly keyId: string;
  readonly teamId: string;
  readonly clientId: string;
  readonly keyContent: string;
  readonly nowSeconds?: number;
}): Promise<string> {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const key = await importPKCS8(input.keyContent, "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: input.keyId })
    .setIssuer(input.teamId)
    .setSubject(input.clientId)
    .setAudience("https://appleid.apple.com")
    .setIssuedAt(now)
    .setExpirationTime(now + 5 * 60)
    .sign(key);
}

type Fetch = typeof globalThis.fetch;

const appleErrorResponseSchema = z.object({ error: z.string().min(1) }).passthrough();
const appleTokenResponseSchema = z
  .object({ refresh_token: z.string().min(1), id_token: z.string().min(1) })
  .passthrough();

async function appleError(response: Response): Promise<{ code: string }> {
  try {
    const body: unknown = await response.json();
    const parsed = appleErrorResponseSchema.safeParse(body);
    return { code: parsed.success ? parsed.data.error : `http_${response.status}` };
  } catch {
    return { code: `http_${response.status}` };
  }
}

async function appleTokens(
  response: Response,
): Promise<{ readonly refreshToken: string; readonly identityToken: string }> {
  try {
    const body: unknown = await response.json();
    const parsed = appleTokenResponseSchema.safeParse(body);
    if (parsed.success) {
      return {
        refreshToken: parsed.data.refresh_token,
        identityToken: parsed.data.id_token,
      };
    }
  } catch {
    // Invalid JSON and invalid response shapes are the same permanent provider contract failure.
  }
  throw new AppleRevocationPermanentError("missing_refresh_token");
}

function permanentAppleError(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

const RETRYABLE_APPLE_JWKS_ERROR_CODES: ReadonlySet<string> = new Set([
  "ERR_JOSE_GENERIC",
  "ERR_JWKS_INVALID",
  "ERR_JWKS_TIMEOUT",
]);

export function isRetryableAppleIdentityVerificationError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof errors.JOSEError && RETRYABLE_APPLE_JWKS_ERROR_CODES.has(error.code))
  );
}

export function createAppleRevocationGateway(input: {
  readonly clientId: string;
  readonly clientSecret: () => Promise<string>;
  readonly fetch?: Fetch;
  readonly verifyIdentityToken?: (token: string, expectedSubject: string) => Promise<void>;
}): AppleRevocationGateway {
  const fetcher = input.fetch ?? globalThis.fetch;
  const verifyIdentityToken =
    input.verifyIdentityToken ??
    (async (token: string, expectedSubject: string) => {
      let verified: Awaited<ReturnType<typeof jwtVerify>>;
      try {
        verified = await jwtVerify(token, APPLE_JWKS, {
          issuer: APPLE_ISSUER,
          audience: input.clientId,
        });
      } catch (error) {
        if (isRetryableAppleIdentityVerificationError(error)) throw error;
        throw new AppleRevocationPermanentError("invalid_identity_token");
      }
      if (verified.payload.sub !== expectedSubject) {
        throw new AppleRevocationPermanentError("apple_subject_mismatch");
      }
    });
  const request = async (url: string, fields: Record<string, string>): Promise<Response> =>
    fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: await input.clientSecret(),
        ...fields,
      }),
    });
  return {
    async exchangeAuthorizationCode(authorizationCode, expectedSubject) {
      const response = await request(APPLE_AUTH_TOKEN_URL, {
        grant_type: "authorization_code",
        code: authorizationCode,
      });
      if (!response.ok) {
        const { code } = await appleError(response);
        if (permanentAppleError(response.status)) throw new AppleRevocationPermanentError(code);
        throw new Error(`Apple token exchange temporarily unavailable: ${code}`);
      }
      const tokens = await appleTokens(response);
      try {
        await verifyIdentityToken(tokens.identityToken, expectedSubject);
      } catch (error) {
        if (error instanceof AppleRevocationPermanentError) throw error;
        throw new Error("Apple identity verification temporarily unavailable", { cause: error });
      }
      return { refreshToken: tokens.refreshToken };
    },
    async revokeRefreshToken(refreshToken) {
      const response = await request(APPLE_AUTH_REVOKE_URL, {
        token: refreshToken,
        token_type_hint: "refresh_token",
      });
      if (response.ok) return;
      const { code } = await appleError(response);
      if (code === "invalid_token") return;
      if (permanentAppleError(response.status)) throw new AppleRevocationPermanentError(code);
      throw new Error(`Apple token revocation temporarily unavailable: ${code}`);
    },
  };
}
