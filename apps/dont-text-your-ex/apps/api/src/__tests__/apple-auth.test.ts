import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { hashAppleNonce, verifyAppleIdentityToken } from "../apple-auth";

const RAW_NONCE = "nonce_6d09ef65cd477d5e04ff1d91";

async function signedAppleToken(nonce: string | undefined): Promise<{
  readonly token: string;
  readonly publicKey: CryptoKey;
}> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const claims = nonce === undefined ? {} : { nonce };
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://appleid.apple.com")
    .setAudience("co.worldwidewebb.textyourex")
    .setSubject("apple-user-123")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { token, publicKey };
}

describe("Sign in with Apple token verification", () => {
  it("accepts a signed token bound to the raw client nonce", async () => {
    const { token, publicKey } = await signedAppleToken(hashAppleNonce(RAW_NONCE));

    await expect(verifyAppleIdentityToken(token, RAW_NONCE, publicKey)).resolves.toEqual({
      sub: "apple-user-123",
    });
  });

  it("rejects a token bound to a different nonce", async () => {
    const { token, publicKey } = await signedAppleToken(hashAppleNonce("nonce_attacker"));

    await expect(verifyAppleIdentityToken(token, RAW_NONCE, publicKey)).rejects.toThrow(
      "Sign in with Apple nonce mismatch",
    );
  });

  it("rejects a token without a nonce claim", async () => {
    const { token, publicKey } = await signedAppleToken(undefined);

    await expect(verifyAppleIdentityToken(token, RAW_NONCE, publicKey)).rejects.toThrow(
      "Sign in with Apple nonce mismatch",
    );
  });

  it("rejects an absent raw nonce before accepting a token", async () => {
    const { token, publicKey } = await signedAppleToken(hashAppleNonce(RAW_NONCE));

    await expect(verifyAppleIdentityToken(token, "", publicKey)).rejects.toThrow(
      "missing Sign in with Apple nonce",
    );
  });
});
