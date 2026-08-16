import { describe, expect, it, vi } from "vitest";
import { createCachedApnsAuthorization, signApnsProviderJwt } from "./apns-jwt";

describe("APNs provider authorization", () => {
  it("reuses a provider token for less than twenty minutes", async () => {
    let now = 1_750_000_000_000;
    const sign = vi.fn(async () => `jwt-${now}`);
    const authorization = createCachedApnsAuthorization(
      { keyId: "KEY", teamId: "TEAM", keyContent: "p8" },
      sign,
      () => now,
    );

    expect(await authorization()).toBe(`bearer jwt-${now}`);
    now += 19 * 60_000;
    expect(await authorization()).toBe("bearer jwt-1750000000000");
    now += 2 * 60_000;
    expect(await authorization()).toBe(`bearer jwt-${now}`);
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it("creates an ES256 token verifiable by the matching public key", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    const token = await signApnsProviderJwt(
      {
        keyId: "KEY123",
        teamId: "TEAM123",
        keyContent: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString("base64")}\n-----END PRIVATE KEY-----`,
      },
      1_750_000_000_000,
    );
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEY123",
    });
    expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString())).toEqual({
      iss: "TEAM123",
      iat: 1_750_000_000,
    });
    await expect(
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        pair.publicKey,
        Buffer.from(signature ?? "", "base64url"),
        new TextEncoder().encode(`${header}.${claims}`),
      ),
    ).resolves.toBe(true);
  });
});
