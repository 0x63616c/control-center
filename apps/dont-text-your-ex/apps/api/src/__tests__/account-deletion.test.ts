import { describe, expect, it } from "vitest";
import { createAccountDeletionCipher, parseAccountDeletionKeyring } from "../account-deletion";

describe("account deletion credential protection", () => {
  it("seals Apple authorization material to one opaque deletion request context", () => {
    const cipher = createAccountDeletionCipher(
      parseAccountDeletionKeyring({
        activeKeyId: "v1",
        keys: { v1: Buffer.alloc(32, 9).toString("base64") },
      }),
    );
    const context = "deletion/del_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/authorization-code";
    const sealed = cipher.seal("single-use-authorization-code", context);

    expect(JSON.stringify(sealed)).not.toContain("single-use-authorization-code");
    expect(cipher.open(sealed, context)).toBe("single-use-authorization-code");
    expect(() =>
      cipher.open(sealed, "deletion/del_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/authorization-code"),
    ).toThrow("account deletion credential could not be decrypted");
  });
});
