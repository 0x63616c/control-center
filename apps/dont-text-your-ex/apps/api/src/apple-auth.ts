import { createHash } from "node:crypto";
import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { MeDTO, SessionToken, UserDTO, UserId } from "../../../contracts";
import { appleBundleId } from "./env";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS = createRemoteJWKSet(new URL(`${APPLE_ISSUER}/auth/keys`));

type AppleVerificationKey = CryptoKey | Uint8Array | JWTVerifyGetKey;

export type AppleAccountStore = {
  readonly findUserByAppleId: (appleId: string) => Promise<UserDTO | null>;
  readonly createUser: (input: {
    readonly name: string;
    readonly appleId: string;
    readonly authProvider: "apple";
  }) => Promise<UserDTO>;
  readonly createSession: (userId: UserId) => Promise<SessionToken>;
  readonly getMe: (userId: UserId) => Promise<MeDTO | null>;
};

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

export async function verifyAppleAccountReauthentication(
  input: Readonly<{ identityToken: string; nonce: string; expectedSubject: string }>,
  verificationKey: AppleVerificationKey = APPLE_JWKS,
): Promise<void> {
  const { sub } = await verifyAppleIdentityToken(input.identityToken, input.nonce, verificationKey);
  if (sub !== input.expectedSubject) {
    throw new Error("Sign in with Apple account does not match the authenticated account");
  }
}

export async function completeAppleAccountSignIn(
  appleId: string,
  fullName: string | undefined,
  accountStore: AppleAccountStore,
): Promise<{
  readonly response: {
    readonly status: "authenticated" | "needs_profile";
    readonly token: SessionToken;
    readonly user: MeDTO;
  };
  readonly created: boolean;
}> {
  const existing = await accountStore.findUserByAppleId(appleId);
  const created = existing === null;
  // Apple normally returns fullName only on the first authorization. A verified
  // Apple subject can therefore be new to this database without carrying a
  // name; persist the empty profile and let the authenticated setup flow ask.
  const user =
    existing ??
    (await accountStore.createUser({
      name: fullName?.trim() ?? "",
      appleId,
      authProvider: "apple",
    }));
  const token = await accountStore.createSession(user.id);
  const me = await accountStore.getMe(user.id);
  if (!me) throw new Error("signed-in Apple user could not be loaded");
  return {
    response: {
      status: me.name.trim() ? "authenticated" : "needs_profile",
      token,
      user: me,
    },
    created,
  };
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
