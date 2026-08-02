import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture db writes the same way weather-ingest-service.test.ts does: values()
// returns a thenable with onConflictDoUpdate attached (the poll cycle upserts),
// and select() resolves whatever row the test staged.
const captured = vi.hoisted(() => ({
  upserts: [] as Record<string, unknown>[],
  statusRows: [] as Record<string, unknown>[],
}));
vi.mock("./db", () => ({
  db: {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        captured.upserts.push(row);
        return Object.assign(Promise.resolve(), {
          onConflictDoUpdate: () => Promise.resolve(),
        });
      },
    }),
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(captured.statusRows),
      };
      return chain;
    },
  },
}));

// ASC creds are fake but shape-real; the JWT test signs with a locally
// generated P-256 key, never a real .p8.
const envMock = vi.hoisted(() => ({
  ASC_KEY_ID: "TESTKEY123",
  ASC_ISSUER_ID: "00000000-0000-0000-0000-000000000000",
  ASC_KEY_CONTENT: "",
  ASC_APP_ID: "6762095888",
}));
vi.mock("./config", () => ({ config: envMock }));

import {
  getAscBuildStatus,
  getLatestAscBuild,
  parseAscBuildsResponse,
  runAscVersionPollCycle,
  signAscJwt,
} from "./service";

async function generateP8Pem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const b64 = Buffer.from(pkcs8).toString("base64");
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`,
    publicKey: pair.publicKey,
  };
}

function b64urlToJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString());
}

// A live-shaped /v1/builds payload (field names verified against the real API,
// spec 2026-07-11): version is the build number AS A STRING, marketing version
// rides the preReleaseVersions include.
function buildsResponse(version = "68") {
  return {
    data: [
      {
        attributes: {
          version,
          uploadedDate: "2026-06-17T11:27:37-07:00",
        },
      },
    ],
    included: [{ type: "preReleaseVersions", attributes: { version: "1.0" } }],
  };
}

beforeEach(() => {
  captured.upserts.length = 0;
  captured.statusRows.length = 0;
  envMock.ASC_KEY_ID = "TESTKEY123";
  envMock.ASC_ISSUER_ID = "00000000-0000-0000-0000-000000000000";
  envMock.ASC_KEY_CONTENT = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signAscJwt", () => {
  it("emits an ES256 JWT with the ASC header/payload contract and a valid signature", async () => {
    const { pem, publicKey } = await generateP8Pem();
    const nowMs = 1_750_000_000_000;
    const jwt = await signAscJwt("TESTKEY123", "issuer-uuid", pem, nowMs);

    const [headerPart, payloadPart, sigPart] = jwt.split(".");
    expect(b64urlToJson(headerPart)).toEqual({ alg: "ES256", kid: "TESTKEY123", typ: "JWT" });
    const payload = b64urlToJson(payloadPart);
    expect(payload.iss).toBe("issuer-uuid");
    expect(payload.aud).toBe("appstoreconnect-v1");
    expect(payload.iat).toBe(Math.floor(nowMs / 1000));
    // ASC rejects tokens living longer than 20 minutes; ours is 10.
    expect((payload.exp as number) - (payload.iat as number)).toBe(600);

    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      Buffer.from(sigPart, "base64url"),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    expect(valid).toBe(true);
  });

  it("accepts a base64-encoded .p8 (vault format, fastlane is_key_content_base64)", async () => {
    const { pem, publicKey } = await generateP8Pem();
    const base64Pem = Buffer.from(pem).toString("base64");
    const jwt = await signAscJwt("TESTKEY123", "issuer-uuid", base64Pem, 1_750_000_000_000);

    const [headerPart, payloadPart, sigPart] = jwt.split(".");
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      Buffer.from(sigPart, "base64url"),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    expect(valid).toBe(true);
  });
});

describe("parseAscBuildsResponse", () => {
  it("extracts build number, uploadedDate, and the preReleaseVersions marketing version", () => {
    expect(parseAscBuildsResponse(buildsResponse())).toEqual({
      buildNumber: 68,
      marketingVersion: "1.0",
      uploadedDate: "2026-06-17T11:27:37-07:00",
    });
  });

  it("returns null for an empty build list", () => {
    expect(parseAscBuildsResponse({ data: [] })).toBeNull();
  });

  it("tolerates a missing include, marketing version falls back to empty", () => {
    const res = buildsResponse();
    const { included: _dropped, ...withoutInclude } = res;
    expect(parseAscBuildsResponse(withoutInclude)?.marketingVersion).toBe("");
  });

  it("throws loudly on a non-numeric build version", () => {
    expect(() => parseAscBuildsResponse(buildsResponse("not-a-number"))).toThrow(/numeric/);
  });

  it("rejects a build version with trailing garbage rather than truncating it", () => {
    expect(() => parseAscBuildsResponse(buildsResponse("68x"))).toThrow(/numeric/);
  });

  it("rejects a malformed uploadedDate at the edge", () => {
    const res = buildsResponse();
    for (const build of res.data) build.attributes.uploadedDate = "not-a-date";
    expect(() => parseAscBuildsResponse(res)).toThrow();
  });

  it("throws loudly on a malformed payload", () => {
    expect(() => parseAscBuildsResponse({ builds: [] })).toThrow();
  });
});

describe("getLatestAscBuild", () => {
  it("returns null without calling ASC when credentials are unset", async () => {
    envMock.ASC_KEY_CONTENT = "";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await getLatestAscBuild()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches with the VALID-only filter and parses the latest build", async () => {
    const { pem } = await generateP8Pem();
    envMock.ASC_KEY_CONTENT = pem;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(buildsResponse()), { status: 200 }));

    expect(await getLatestAscBuild()).toEqual({
      buildNumber: 68,
      marketingVersion: "1.0",
      uploadedDate: "2026-06-17T11:27:37-07:00",
    });
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("filter[app]=6762095888");
    expect(url).toContain("filter[processingState]=VALID");
    // Upload order, not version order: ASC's version field is a string and a
    // -version sort risks lexicographic ordering across digit boundaries.
    expect(url).toContain("sort=-uploadedDate");
  });

  it("returns null on an ASC error response instead of throwing", async () => {
    const { pem } = await generateP8Pem();
    envMock.ASC_KEY_CONTENT = pem;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    expect(await getLatestAscBuild()).toBeNull();
  });
});

describe("runAscVersionPollCycle", () => {
  it("upserts the singleton row from the fetched build", async () => {
    const { pem } = await generateP8Pem();
    envMock.ASC_KEY_CONTENT = pem;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(buildsResponse()), { status: 200 }),
    );

    await runAscVersionPollCycle();
    expect(captured.upserts).toHaveLength(1);
    expect(captured.upserts[0]).toMatchObject({
      id: "singleton",
      buildNumber: 68,
      marketingVersion: "1.0",
    });
    expect(captured.upserts[0]?.uploadedAtUtc).toBeInstanceOf(Date);
  });

  it("leaves the cache untouched when the fetch fails", async () => {
    const { pem } = await generateP8Pem();
    envMock.ASC_KEY_CONTENT = pem;
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    await runAscVersionPollCycle();
    expect(captured.upserts).toHaveLength(0);
  });
});

describe("getAscBuildStatus", () => {
  it("returns null when the poller has never written a row", async () => {
    expect(await getAscBuildStatus()).toBeNull();
  });

  it("serializes the cached row's timestamps to ISO strings", async () => {
    captured.statusRows.push({
      id: "singleton",
      buildNumber: 68,
      marketingVersion: "1.0",
      uploadedAtUtc: new Date("2026-06-17T18:27:37.000Z"),
      fetchedAtUtc: new Date("2026-07-11T00:00:00.000Z"),
    });
    expect(await getAscBuildStatus()).toEqual({
      buildNumber: 68,
      marketingVersion: "1.0",
      uploadedDate: "2026-06-17T18:27:37.000Z",
      fetchedAt: "2026-07-11T00:00:00.000Z",
    });
  });
});
