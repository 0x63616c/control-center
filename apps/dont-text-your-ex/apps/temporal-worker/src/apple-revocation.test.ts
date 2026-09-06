import { generateKeyPairSync } from "node:crypto";
import { decodeProtectedHeader, errors, exportPKCS8, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  AppleRevocationPermanentError,
  createAppleClientSecret,
  createAppleRevocationGateway,
  isRetryableAppleIdentityVerificationError,
} from "./apple-revocation";

describe("Apple revocation gateway", () => {
  it("creates a short-lived ES256 Apple client secret with the configured identity", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const keyContent = await exportPKCS8(privateKey);
    const token = await createAppleClientSecret({
      keyId: "APPLEKEY1",
      teamId: "TEAM123",
      clientId: "co.worldwidewebb.textyourex",
      keyContent,
      nowSeconds: 1_700_000_000,
    });

    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "ES256", kid: "APPLEKEY1" });
    const verified = await jwtVerify(token, publicKey, {
      issuer: "TEAM123",
      audience: "https://appleid.apple.com",
      subject: "co.worldwidewebb.textyourex",
      currentDate: new Date(1_700_000_001_000),
    });
    expect(verified.payload.exp).toBe(1_700_000_300);
  });

  it("exchanges the one-time code and revokes the returned refresh token without credentials in errors", async () => {
    const requests: Array<{ url: string; body: URLSearchParams }> = [];
    const fetcher = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(request), body: new URLSearchParams(String(init?.body)) });
      return requests.length === 1
        ? Response.json({ refresh_token: "refresh-secret", id_token: "identity-token" })
        : new Response(null, { status: 200 });
    });
    const gateway = createAppleRevocationGateway({
      clientId: "co.worldwidewebb.textyourex",
      clientSecret: async () => "signed-client-secret",
      fetch: fetcher as never,
      verifyIdentityToken: async (token, expectedSubject) => {
        expect(token).toBe("identity-token");
        expect(expectedSubject).toBe("apple-subject");
      },
    });

    const exchanged = await gateway.exchangeAuthorizationCode(
      "authorization-secret",
      "apple-subject",
    );
    await gateway.revokeRefreshToken(exchanged.refreshToken);

    expect(requests.map(({ url }) => url)).toEqual([
      "https://appleid.apple.com/auth/token",
      "https://appleid.apple.com/auth/revoke",
    ]);
    expect(requests[0]?.body.get("grant_type")).toBe("authorization_code");
    expect(requests[1]?.body.get("token_type_hint")).toBe("refresh_token");
  });

  it("classifies invalid grants as permanent and server failures as retryable", async () => {
    const permanent = createAppleRevocationGateway({
      clientId: "client",
      clientSecret: async () => "secret",
      fetch: vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as never,
      verifyIdentityToken: vi.fn(),
    });
    await expect(permanent.exchangeAuthorizationCode("code", "subject")).rejects.toBeInstanceOf(
      AppleRevocationPermanentError,
    );

    const transient = createAppleRevocationGateway({
      clientId: "client",
      clientSecret: async () => "secret",
      fetch: vi.fn(async () => new Response(null, { status: 503 })) as never,
    });
    await expect(transient.revokeRefreshToken("token")).rejects.toThrow(/temporarily unavailable/);
  });

  it("rejects malformed successful token responses as permanent provider failures", async () => {
    for (const response of [
      Response.json({ refresh_token: 42 }),
      new Response("not-json", { headers: { "Content-Type": "application/json" } }),
    ]) {
      const gateway = createAppleRevocationGateway({
        clientId: "client",
        clientSecret: async () => "secret",
        fetch: vi.fn(async () => response) as never,
        verifyIdentityToken: vi.fn(),
      });

      await expect(gateway.exchangeAuthorizationCode("code", "subject")).rejects.toThrow(
        "Apple revocation cannot be retried: missing_refresh_token",
      );
    }
  });

  it("rejects an exchanged authorization code whose signed identity belongs to another subject", async () => {
    const gateway = createAppleRevocationGateway({
      clientId: "client",
      clientSecret: async () => "secret",
      fetch: vi.fn(async () =>
        Response.json({ refresh_token: "refresh", id_token: "identity-token" }),
      ) as never,
      verifyIdentityToken: async () => {
        throw new AppleRevocationPermanentError("apple_subject_mismatch");
      },
    });

    await expect(gateway.exchangeAuthorizationCode("code", "expected-subject")).rejects.toThrow(
      "apple_subject_mismatch",
    );
  });

  it("keeps Apple identity-key network failures retryable", async () => {
    const gateway = createAppleRevocationGateway({
      clientId: "client",
      clientSecret: async () => "secret",
      fetch: vi.fn(async () =>
        Response.json({ refresh_token: "refresh", id_token: "identity-token" }),
      ) as never,
      verifyIdentityToken: async () => {
        throw new TypeError("JWKS fetch failed");
      },
    });

    const failure = gateway.exchangeAuthorizationCode("code", "expected-subject");
    await expect(failure).rejects.toThrow("temporarily unavailable");
    await expect(failure).rejects.not.toBeInstanceOf(AppleRevocationPermanentError);
  });

  it("keeps non-200 and malformed Apple JWKS responses retryable", () => {
    expect(
      isRetryableAppleIdentityVerificationError(
        new errors.JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response"),
      ),
    ).toBe(true);
    expect(
      isRetryableAppleIdentityVerificationError(
        new errors.JWKSTimeout("request timed out while fetching the JSON Web Key Set"),
      ),
    ).toBe(true);
    expect(
      isRetryableAppleIdentityVerificationError(
        new errors.JWKSInvalid("Apple returned a malformed JSON Web Key Set"),
      ),
    ).toBe(true);
    expect(
      isRetryableAppleIdentityVerificationError(
        new errors.JWSSignatureVerificationFailed("signature verification failed"),
      ),
    ).toBe(false);
  });

  it("falls back to the HTTP status when Apple's error response has the wrong shape", async () => {
    const gateway = createAppleRevocationGateway({
      clientId: "client",
      clientSecret: async () => "secret",
      fetch: vi.fn(async () => Response.json({ error: 503 }, { status: 503 })) as never,
    });

    await expect(gateway.revokeRefreshToken("token")).rejects.toThrow(
      "Apple token revocation temporarily unavailable: http_503",
    );
  });

  it("treats Apple's invalid-token response as an already-satisfied revocation", async () => {
    const gateway = createAppleRevocationGateway({
      clientId: "client",
      clientSecret: async () => "secret",
      fetch: vi.fn(async () => Response.json({ error: "invalid_token" }, { status: 400 })) as never,
    });

    await expect(gateway.revokeRefreshToken("already-revoked-token")).resolves.toBeUndefined();
  });
});
