const CACHE_MS = 20 * 60_000;

export interface ApnsProviderKey {
  readonly keyId: string;
  readonly teamId: string;
  readonly keyContent: string;
}

type JwtSigner = (key: ApnsProviderKey, nowMs: number) => Promise<string>;

function keyBytes(keyContent: string): ArrayBuffer {
  const pem = keyContent.includes("BEGIN")
    ? keyContent
    : Buffer.from(keyContent.replace(/\s+/g, ""), "base64").toString("utf8");
  const encoded = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  return Uint8Array.from(Buffer.from(encoded, "base64")).buffer;
}

function base64url(input: string | Uint8Array): string {
  return Buffer.from(typeof input === "string" ? new TextEncoder().encode(input) : input).toString(
    "base64url",
  );
}

export async function signApnsProviderJwt(key: ApnsProviderKey, nowMs: number): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: key.keyId }));
  const claims = base64url(JSON.stringify({ iss: key.teamId, iat: Math.floor(nowMs / 1_000) }));
  const signingInput = `${header}.${claims}`;
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes(key.keyContent),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

export function createCachedApnsAuthorization(
  key: ApnsProviderKey,
  sign: JwtSigner = signApnsProviderJwt,
  clock: () => number = Date.now,
): () => Promise<string> {
  let cached: { readonly jwt: string; readonly createdAt: number } | undefined;
  return async () => {
    const now = clock();
    if (!cached || now - cached.createdAt >= CACHE_MS) {
      cached = { jwt: await sign(key, now), createdAt: now };
    }
    return `bearer ${cached.jwt}`;
  };
}
