import { describe, expect, test } from "vitest";
import { createTokenCipher, parseTokenKeyring } from "./token-cipher";

const key = Buffer.alloc(32, 7).toString("base64");
const nextKey = Buffer.alloc(32, 9).toString("base64");

describe("push token cipher", () => {
  test("round trips with authenticated context and never stores plaintext", () => {
    const cipher = createTokenCipher(parseTokenKeyring({ activeKeyId: "v1", keys: { v1: key } }));
    const sealed = cipher.seal("aabbccdd00112233aabbccdd00112233", "dev_device");

    expect(sealed.ciphertext).not.toContain("aabbccdd");
    expect(sealed.keyId).toBe("v1");
    expect(cipher.open(sealed, "dev_device")).toBe("aabbccdd00112233aabbccdd00112233");
  });

  test("rejects an AAD swap", () => {
    const cipher = createTokenCipher(parseTokenKeyring({ activeKeyId: "v1", keys: { v1: key } }));
    const sealed = cipher.seal("aabbccdd00112233aabbccdd00112233", "dev_one");
    expect(() => cipher.open(sealed, "dev_two")).toThrow(/decrypt/);
  });

  test("reads old keys while all new writes use the active key", () => {
    const oldCipher = createTokenCipher(
      parseTokenKeyring({ activeKeyId: "v1", keys: { v1: key } }),
    );
    const old = oldCipher.seal("aabbccdd00112233aabbccdd00112233", "dev_device");
    const rotated = createTokenCipher(
      parseTokenKeyring({ activeKeyId: "v2", keys: { v1: key, v2: nextKey } }),
    );
    expect(rotated.open(old, "dev_device")).toContain("00112233");
    expect(rotated.seal("aabbccdd00112233aabbccdd00112233", "dev_device").keyId).toBe("v2");
  });

  test("rejects malformed keyrings", () => {
    expect(() => parseTokenKeyring({ activeKeyId: "missing", keys: { v1: key } })).toThrow();
    expect(() => parseTokenKeyring({ activeKeyId: "v1", keys: { v1: "short" } })).toThrow();
  });
});
