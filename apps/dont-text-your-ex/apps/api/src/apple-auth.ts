import { createHash } from "node:crypto";
import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import { appleBundleId } from "./env";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS = createRemoteJWKSet(new URL(`${APPLE_ISSUER}/auth/keys`));

type AppleVerificationKey = CryptoKey | Uint8Array | JWTVerifyGetKey;

export function hashAppleNonce(rawNonce: string): string {
  return createHash("sha256").update(rawNonce, "utf8").digest("hex");
}

export async function verifyAppleIdentityToken(
  identityToken: string,
  rawNonce: string,
  verificationKey: AppleVerificationKey = APPLE_JWKS,
): Promise<{ readonly sub: string }> {
  if (!rawNonce) {
    throw new Error("missing Sign in with Apple nonce");
  }

  const { payload } = await jwtVerify(identityToken, verificationKey, {
    issuer: APPLE_ISSUER,
    audience: appleBundleId(),
  });
  assertAppleClaims(payload, hashAppleNonce(rawNonce));
  return { sub: payload.sub };
}

function assertAppleClaims(
  payload: JWTPayload,
  expectedNonce: string,
): asserts payload is JWTPayload & { readonly sub: string } {
  if (!payload.sub) {
    throw new Error("missing sub in Apple JWT");
  }
  if (payload.nonce !== expectedNonce) {
    throw new Error("Sign in with Apple nonce mismatch");
  }
}
