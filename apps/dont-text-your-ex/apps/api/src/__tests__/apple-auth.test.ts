import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { MeSchema, SessionTokenSchema, type UserDTO, UserIdSchema } from "../../../../contracts";
import {
  type AppleAccountStore,
  completeAppleAccountSignIn,
  hashAppleNonce,
  verifyAppleAccountReauthentication,
  verifyAppleIdentityToken,
} from "../apple-auth";

const RAW_NONCE = "nonce_6d09ef65cd477d5e04ff1d91";

async function signedAppleToken(
  nonce: string | undefined,
  overrides: { readonly issuer?: string; readonly audience?: string } = {},
): Promise<{
  readonly token: string;
  readonly publicKey: CryptoKey;
}> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const claims = nonce === undefined ? {} : { nonce };
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(overrides.issuer ?? "https://appleid.apple.com")
    .setAudience(overrides.audience ?? "co.worldwidewebb.textyourex")
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

  it("accepts fresh account authorization only for the authenticated Apple subject", async () => {
    const { token, publicKey } = await signedAppleToken(hashAppleNonce(RAW_NONCE));

    await expect(
      verifyAppleAccountReauthentication(
        { identityToken: token, nonce: RAW_NONCE, expectedSubject: "apple-user-123" },
        publicKey,
      ),
    ).resolves.toBeUndefined();
    await expect(
      verifyAppleAccountReauthentication(
        { identityToken: token, nonce: RAW_NONCE, expectedSubject: "different-apple-user" },
        publicKey,
      ),
    ).rejects.toThrow("does not match the authenticated account");
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

  it("rejects a correctly signed token from the wrong issuer", async () => {
    const { token, publicKey } = await signedAppleToken(hashAppleNonce(RAW_NONCE), {
      issuer: "https://attacker.invalid",
    });

    await expect(verifyAppleIdentityToken(token, RAW_NONCE, publicKey)).rejects.toThrow();
  });

  it("rejects a correctly signed token for the wrong audience", async () => {
    const { token, publicKey } = await signedAppleToken(hashAppleNonce(RAW_NONCE), {
      audience: "co.attacker.invalid",
    });

    await expect(verifyAppleIdentityToken(token, RAW_NONCE, publicKey)).rejects.toThrow();
  });

  it("rejects a token whose signature does not match the verification key", async () => {
    const { token } = await signedAppleToken(hashAppleNonce(RAW_NONCE));
    const { publicKey: unrelatedKey } = await generateKeyPair("RS256");

    await expect(verifyAppleIdentityToken(token, RAW_NONCE, unrelatedKey)).rejects.toThrow();
  });
});

function accountStore(existing: UserDTO | null = null): {
  readonly store: AppleAccountStore;
  readonly createdNames: string[];
} {
  const createdNames: string[] = [];
  const created = {
    id: UserIdSchema.parse("usr_recovered"),
    name: "",
    color: "#5E5CE6",
    emoji: null,
    photo: null,
  };
  let current = existing ?? created;
  return {
    createdNames,
    store: {
      findUserByAppleId: async () => existing,
      createUser: async ({ name }) => {
        createdNames.push(name);
        current = { ...created, name };
        return current;
      },
      createSession: async () => SessionTokenSchema.parse("sess_recovered"),
      getMe: async (userId) => MeSchema.parse({ ...current, id: userId, exes: [], phone: null }),
    },
  };
}

describe("verified Apple account completion", () => {
  it("creates an unnamed profile when Apple no longer returns fullName", async () => {
    const fake = accountStore();

    const result = await completeAppleAccountSignIn("apple-user-123", undefined, fake.store);

    expect(fake.createdNames).toEqual([""]);
    expect(result).toMatchObject({
      created: true,
      response: { status: "needs_profile", user: { name: "" } },
    });
  });

  it("uses Apple's first-authorization name without inventing a fallback", async () => {
    const fake = accountStore();

    const result = await completeAppleAccountSignIn(
      "apple-user-123",
      "  Taylor Appleseed  ",
      fake.store,
    );

    expect(fake.createdNames).toEqual(["Taylor Appleseed"]);
    expect(result.response).toMatchObject({
      status: "authenticated",
      user: { name: "Taylor Appleseed" },
    });
  });

  it("reauthorizes an existing account when fullName is absent", async () => {
    const existing = {
      id: UserIdSchema.parse("usr_existing"),
      name: "Taylor",
      color: "#5E5CE6",
      emoji: null,
      photo: null,
      exes: [],
    };
    const fake = accountStore(existing);

    const result = await completeAppleAccountSignIn("apple-user-123", undefined, fake.store);

    expect(fake.createdNames).toEqual([]);
    expect(result).toMatchObject({
      created: false,
      response: { status: "authenticated", user: { name: "Taylor" } },
    });
  });
});
