import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const encodedKeySchema = z.string().transform((value, ctx) => {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    ctx.addIssue({ code: "custom", message: "push token encryption keys must be 32 bytes" });
    return z.NEVER;
  }
  return key;
});

const rawKeyringSchema = z
  .object({ activeKeyId: z.string().min(1), keys: z.record(z.string().min(1), encodedKeySchema) })
  .strict();

export interface TokenKeyring {
  readonly activeKeyId: string;
  readonly keys: Readonly<Record<string, Buffer>>;
}

export interface SealedToken {
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
}

export interface TokenCipher {
  readonly activeKeyId: string;
  seal(token: string, context: string): SealedToken;
  open(sealed: SealedToken, context: string): string;
}

export function parseTokenKeyring(input: unknown): TokenKeyring {
  const parsed = rawKeyringSchema.parse(input);
  if (!parsed.keys[parsed.activeKeyId]) throw new Error("active push token key is missing");
  return parsed;
}

export function createTokenCipher(keyring: TokenKeyring): TokenCipher {
  return {
    activeKeyId: keyring.activeKeyId,
    seal(token, context) {
      const nonce = randomBytes(12);
      const key = keyring.keys[keyring.activeKeyId];
      if (!key) throw new Error("active push token key is missing");
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
      const ciphertext = Buffer.concat([body, cipher.getAuthTag()]);
      return {
        keyId: keyring.activeKeyId,
        nonce: nonce.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
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
        throw new Error("push token could not be decrypted");
      }
    },
  };
}
