import { getLogger } from "@www/logger";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { config } from "./config";
import { db } from "./db";
import { ASC_BUILD_STATUS_SINGLETON_ID, ascBuildStatus } from "./schema";

// App Store Connect version poller. Detects when a newer TestFlight build of
// the wall-panel iOS shell exists than the one installed on the panel. The
// worker calls runAscVersionPollCycle on an interval; the latest VALID
// (installable) build is upserted into the asc_build_status singleton row and
// served to the board via system.appUpdateStatus. The shell app is
// TestFlight-only (never a public App Store release), so ASC builds ARE the
// release channel.

const ASC_BASE_URL = "https://api.appstoreconnect.apple.com";
// ASC JWTs may live at most 20 minutes; sign a fresh short-lived token per
// cycle (one request/minute) instead of caching one across cycles.
const JWT_TTL_SECONDS = 10 * 60;

// Edge schema (same rationale as the Open-Meteo bundle in weather-ingest): the
// ASC response is validated here so a changed/malformed payload fails loudly at
// the boundary instead of writing garbage into the singleton row. Field names
// verified against the live API (spec 2026-07-11): builds[].attributes.version
// is the build number AS A STRING ("68"), uploadedDate is ISO 8601 with offset,
// and the marketing version rides the preReleaseVersions include.
const ascBuildsResponseSchema = z.object({
  data: z.array(
    z.object({
      attributes: z.object({
        // Strict digits: parseInt would silently accept "68x"; a non-numeric
        // build number must fail loudly, not truncate.
        version: z.string().regex(/^\d+$/, "build version must be numeric"),
        uploadedDate: z.string().datetime({ offset: true }),
      }),
    }),
  ),
  included: z
    .array(
      z.object({
        type: z.string(),
        attributes: z.object({ version: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});

export interface AscBuild {
  buildNumber: number;
  marketingVersion: string;
  uploadedDate: string;
}

function isAscConfigured(): boolean {
  return Boolean(
    config.ASC_KEY_ID && config.ASC_ISSUER_ID && config.ASC_KEY_CONTENT && config.ASC_APP_ID,
  );
}

function base64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return Buffer.from(bytes).toString("base64url");
}

function pemToPkcs8(keyContent: string): ArrayBuffer {
  // The vault stores the .p8 base64-encoded (fastlane consumes it with
  // is_key_content_base64: true), so the mounted secret usually has no PEM
  // armor. Accept both: decode to PEM when the armor is missing.
  const pem = keyContent.includes("BEGIN")
    ? keyContent
    : Buffer.from(keyContent.replace(/\s+/g, ""), "base64").toString("utf-8");
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  return Uint8Array.from(Buffer.from(b64, "base64")).buffer;
}

/**
 * Sign a short-lived ASC API JWT (ES256) from the .p8 key. Uses Web Crypto
 * (crypto.subtle), NOT node:crypto: JWT ES256 requires the raw R||S signature
 * that subtle emits natively, and Bun's createSign with
 * `dsaEncoding: "ieee-p1363"` throws RangeError (verified 2026-07-11).
 */
export async function signAscJwt(
  keyId: string,
  issuerId: string,
  p8Pem: string,
  nowMs = Date.now(),
): Promise<string> {
  const nowSec = Math.floor(nowMs / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = {
    iss: issuerId,
    iat: nowSec,
    exp: nowSec + JWT_TTL_SECONDS,
    aud: "appstoreconnect-v1",
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(p8Pem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

/** Parse a validated ASC /v1/builds response into an AscBuild, or null when empty. */
export function parseAscBuildsResponse(json: unknown): AscBuild | null {
  const parsed = ascBuildsResponseSchema.parse(json);
  const build = parsed.data[0];
  if (!build) return null;
  const buildNumber = Number.parseInt(build.attributes.version, 10);
  const marketingVersion =
    parsed.included?.find((i) => i.type === "preReleaseVersions")?.attributes?.version ?? "";
  return { buildNumber, marketingVersion, uploadedDate: build.attributes.uploadedDate };
}

/**
 * Fetch the newest installable TestFlight build from ASC. Returns null on any
 * failure (auth, network, empty build list) so the caller keeps the last cached
 * row rather than flapping the banner on a transient ASC error.
 */
export async function getLatestAscBuild(): Promise<AscBuild | null> {
  if (!isAscConfigured()) return null;
  try {
    const jwt = await signAscJwt(config.ASC_KEY_ID, config.ASC_ISSUER_ID, config.ASC_KEY_CONTENT);
    // processingState=VALID: only count builds that are actually installable,
    // so a build still PROCESSING in TestFlight never shows as an update.
    // sort=-uploadedDate, not -version: ASC's version is a string field, so a
    // version sort risks lexicographic order ("9" > "100"); upload order IS
    // build order here (fastlane assigns latest_testflight_build_number + 1
    // per upload), so the newest upload is the numeric max.
    const url =
      `${ASC_BASE_URL}/v1/builds?filter[app]=${config.ASC_APP_ID}` +
      `&filter[processingState]=VALID&sort=-uploadedDate&limit=1&include=preReleaseVersion`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseAscBuildsResponse(await res.json());
  } catch (err) {
    getLogger().warn({ err }, "asc-version: fetch latest build failed, keeping last cache");
    return null;
  }
}

export interface AscBuildStatus extends AscBuild {
  fetchedAt: string;
}

/** Read the cached latest-build row; null when the poller has never succeeded. */
export async function getAscBuildStatus(): Promise<AscBuildStatus | null> {
  const rows = await db
    .select()
    .from(ascBuildStatus)
    .where(eq(ascBuildStatus.id, ASC_BUILD_STATUS_SINGLETON_ID))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    buildNumber: row.buildNumber,
    marketingVersion: row.marketingVersion,
    uploadedDate: row.uploadedAtUtc.toISOString(),
    fetchedAt: row.fetchedAtUtc.toISOString(),
  };
}

/**
 * One poll cycle: fetch the latest build and upsert the singleton cache row.
 * A null fetch (unconfigured, transient ASC error) leaves the existing row
 * untouched, so the served status only ever moves forward.
 */
export async function runAscVersionPollCycle(): Promise<void> {
  const latest = await getLatestAscBuild();
  if (!latest) return;
  const now = new Date();
  await db
    .insert(ascBuildStatus)
    .values({
      id: ASC_BUILD_STATUS_SINGLETON_ID,
      buildNumber: latest.buildNumber,
      marketingVersion: latest.marketingVersion,
      uploadedAtUtc: new Date(latest.uploadedDate),
      fetchedAtUtc: now,
    })
    .onConflictDoUpdate({
      target: ascBuildStatus.id,
      set: {
        buildNumber: latest.buildNumber,
        marketingVersion: latest.marketingVersion,
        uploadedAtUtc: new Date(latest.uploadedDate),
        fetchedAtUtc: now,
      },
    });
}
