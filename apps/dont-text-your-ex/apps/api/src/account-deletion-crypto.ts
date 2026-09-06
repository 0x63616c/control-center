import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const encodedDeletionKeySchema = z.string().transform((value, context) => {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    context.addIssue({ code: "custom", message: "account deletion keys must be 32 bytes" });
    return z.NEVER;
  }
  return key;
});
const deletionKeyringSchema = z
  .object({
    activeKeyId: z.string().min(1),
    keys: z.record(z.string().min(1), encodedDeletionKeySchema),
  })
  .strict();

export type AccountDeletionKeyring = Readonly<{
  activeKeyId: string;
  keys: Readonly<Record<string, Buffer>>;
}>;
type SealedAccountDeletionCredential = Readonly<{
  keyId: string;
  nonce: string;
  ciphertext: string;
}>;
export interface AccountDeletionCipher {
  seal(value: string, context: string): SealedAccountDeletionCredential;
  open(sealed: SealedAccountDeletionCredential, context: string): string;
}

export function parseAccountDeletionKeyring(input: unknown): AccountDeletionKeyring {
  const parsed = deletionKeyringSchema.parse(input);
  if (!parsed.keys[parsed.activeKeyId]) {
    throw new Error("active account deletion key is missing");
  }
  return parsed;
}

export function createAccountDeletionCipher(
  keyring: AccountDeletionKeyring,
): AccountDeletionCipher {
  return {
    seal(value, context) {
      const nonce = randomBytes(12);
      const key = keyring.keys[keyring.activeKeyId];
      if (!key) throw new Error("active account deletion key is missing");
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return {
        keyId: keyring.activeKeyId,
        nonce: nonce.toString("base64"),
        ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"),
      };
    },
    open(sealed, context) {
      try {
        const key = keyring.keys[sealed.keyId];
        if (!key) throw new Error("key unavailable");
        const payload = Buffer.from(sealed.ciphertext, "base64");
        if (payload.length < 17) throw new Error("ciphertext malformed");
        const body = payload.subarray(0, payload.length - 16);
        const tag = payload.subarray(payload.length - 16);
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce, "base64"));
        decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
      } catch {
        throw new Error("account deletion credential could not be decrypted");
      }
    },
  };
}
