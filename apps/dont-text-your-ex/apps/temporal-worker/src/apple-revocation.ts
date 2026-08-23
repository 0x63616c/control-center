import { importPKCS8, SignJWT } from "jose";
import type { AppleRevocationGateway } from "./account-deletion";

const APPLE_AUTH_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_AUTH_REVOKE_URL = "https://appleid.apple.com/auth/revoke";

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

async function appleError(response: Response): Promise<{ code: string }> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return { code: typeof body.error === "string" ? body.error : `http_${response.status}` };
  } catch {
    return { code: `http_${response.status}` };
  }
}

function permanentAppleError(status: number, code: string): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function createAppleRevocationGateway(input: {
  readonly clientId: string;
  readonly clientSecret: () => Promise<string>;
  readonly fetch?: Fetch;
}): AppleRevocationGateway {
  const fetcher = input.fetch ?? globalThis.fetch;
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
    async exchangeAuthorizationCode(authorizationCode) {
      const response = await request(APPLE_AUTH_TOKEN_URL, {
        grant_type: "authorization_code",
        code: authorizationCode,
      });
      if (!response.ok) {
        const { code } = await appleError(response);
        if (permanentAppleError(response.status, code))
          throw new AppleRevocationPermanentError(code);
        throw new Error(`Apple token exchange temporarily unavailable: ${code}`);
      }
      const body = (await response.json()) as { refresh_token?: unknown };
      if (typeof body.refresh_token !== "string" || body.refresh_token.length === 0) {
        throw new AppleRevocationPermanentError("missing_refresh_token");
      }
      return { refreshToken: body.refresh_token };
    },
    async revokeRefreshToken(refreshToken) {
      const response = await request(APPLE_AUTH_REVOKE_URL, {
        token: refreshToken,
        token_type_hint: "refresh_token",
      });
      if (response.ok) return;
      const { code } = await appleError(response);
      if (code === "invalid_token") return;
      if (permanentAppleError(response.status, code)) throw new AppleRevocationPermanentError(code);
      throw new Error(`Apple token revocation temporarily unavailable: ${code}`);
    },
  };
}
