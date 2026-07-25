import { getLogger } from "@www/logger";
import { z } from "zod";
import { WithingsError } from "./errors";
import type { WithingsCredentials, WithingsMeasureGroup, WithingsTokenPair } from "./types";

const WITHINGS_REQUEST_TIMEOUT_MS = 5_000;
// A successful call slower than this is worth a line: the weigh-in path has a
// <30s end-to-end budget and this request sits inside a 10s poll.
const SLOW_REQUEST_MS = 2_000;
const TOKEN_URL = "https://wbsapi.withings.com/v2/oauth2";
const MEASURE_URL = "https://wbsapi.withings.com/measure";

// meastype 1 = weight. Everything else we keep is just along for the ride into
// bodyMetrics (write-only today, not displayed , see plan for the decision).
const WEIGHT_MEASTYPE = 1;
const BODY_METRIC_MEASTYPES: Record<number, string> = {
  5: "fat_free_mass_kg",
  6: "fat_ratio_percent",
  8: "fat_mass_kg",
  76: "muscle_mass_kg",
  77: "hydration_kg",
  88: "bone_mass_kg",
};

const oauthBodySchema = z.object({
  userid: z.union([z.string(), z.number()]),
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
});

const measureSchema = z.object({
  value: z.number(),
  type: z.number(),
  unit: z.number(),
});

const measureGroupSchema = z.object({
  grpid: z.number(),
  date: z.number(),
  category: z.number(),
  measures: z.array(measureSchema),
});

const getMeasResponseSchema = z.object({
  status: z.number(),
  body: z
    .object({
      measuregrps: z.array(measureGroupSchema),
    })
    .optional(),
  error: z.string().optional(),
});

const oauthResponseSchema = z.object({
  status: z.number(),
  body: oauthBodySchema.optional(),
  error: z.string().optional(),
});

function scale(value: number, unit: number): number {
  return value * 10 ** unit;
}

/**
 * Typed REST client for Withings' cloud API. Env-free (construct via
 * `createWithingsClient({ clientId, clientSecret })`), and deliberately
 * stateless w.r.t. token persistence , every call that mints or rotates a
 * token pair just returns it, so the caller (the one place that knows the
 * currently-persisted value) owns writing it to storage. Caching the token
 * here , like `SpotifyClient` does , would let the client silently reuse a
 * token across calls without the caller ever persisting a rotation, which is
 * exactly the race that strands a Withings account (refresh_token rotates on
 * every use, unlike Spotify's static one).
 */
export class WithingsClient {
  constructor(private readonly creds: WithingsCredentials) {}

  isConfigured(): boolean {
    return this.creds.clientId.length > 0 && this.creds.clientSecret.length > 0;
  }

  private async wFetch(url: string, body: URLSearchParams, logLabel: string): Promise<unknown> {
    const startedAt = performance.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(WITHINGS_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const durationMs = +(performance.now() - startedAt).toFixed(1);
      getLogger().warn({ withingsCall: logLabel, durationMs }, "withings request failed");
      throw new WithingsError(`${logLabel}: network error , ${(err as Error).message}`);
    }
    const durationMs = +(performance.now() - startedAt).toFixed(1);
    if (!res.ok) {
      getLogger().warn(
        { withingsCall: logLabel, withingsStatus: res.status, durationMs },
        "withings request non-2xx",
      );
      throw new WithingsError(`${logLabel}: HTTP ${res.status}`);
    }
    // No per-request success line: the weight poller calls this every 10s, so an
    // "ok" line would be ~8,600/day of pure heartbeat. We do not demote it to
    // debug (docs/logging.md §3 , we never emit below info), we only log the
    // case that carries signal: a call that succeeded but was slow enough to
    // threaten the <30s weigh-in budget. Failures already warn above.
    if (durationMs > SLOW_REQUEST_MS) {
      getLogger().warn({ withingsCall: logLabel, durationMs }, "withings request slow");
    }
    return res.json();
  }

  /**
   * POST /v2/oauth2 action=requesttoken. Takes the CURRENT refresh token
   * explicitly , this client holds no cache, the caller is the only place
   * that knows the persisted value. Returns the NEW rotated pair. Withings
   * always answers HTTP 200; a non-zero in-body `status` is the real error
   * signal and is checked explicitly here.
   */
  async refreshToken(currentRefreshToken: string): Promise<WithingsTokenPair> {
    if (!this.isConfigured()) {
      throw new WithingsError("Withings credentials unconfigured: WITHINGS_CLIENT_ID/SECRET");
    }
    const body = new URLSearchParams({
      action: "requesttoken",
      grant_type: "refresh_token",
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      refresh_token: currentRefreshToken,
    });
    const raw = await this.wFetch(TOKEN_URL, body, "refreshToken");
    const parsed = oauthResponseSchema.parse(raw);
    if (parsed.status !== 0 || !parsed.body) {
      throw new WithingsError(
        `refreshToken: withings status ${parsed.status} , ${parsed.error ?? ""}`,
      );
    }
    getLogger().info({ expiresIn: parsed.body.expires_in }, "withings token refreshed");
    return {
      accessToken: parsed.body.access_token,
      refreshToken: parsed.body.refresh_token,
      expiresAt: new Date(Date.now() + parsed.body.expires_in * 1000),
      withingsUserId: String(parsed.body.userid),
    };
  }

  /**
   * POST /measure action=getmeas category=1 (real measures, not goals)
   * meastype=1 (weight) lastupdate=<cursor>. Returns groups sorted ascending
   * by date, unit-scaled, with any co-reported body-composition meastypes
   * folded into `bodyMetrics`. THROWS WithingsError on non-2xx / non-zero
   * in-body status; parses the body with zod at the boundary.
   */
  async getMeasurementsSince(
    accessToken: string,
    lastUpdate: number,
  ): Promise<WithingsMeasureGroup[]> {
    const body = new URLSearchParams({
      action: "getmeas",
      category: "1",
      lastupdate: String(lastUpdate),
      access_token: accessToken,
    });
    const raw = await this.wFetch(MEASURE_URL, body, "getMeasurementsSince");
    const parsed = getMeasResponseSchema.parse(raw);
    if (parsed.status !== 0 || !parsed.body) {
      throw new WithingsError(
        `getMeasurementsSince: withings status ${parsed.status} , ${parsed.error ?? ""}`,
      );
    }

    const groups: WithingsMeasureGroup[] = parsed.body.measuregrps.map((grp) => {
      let weightKg: number | null = null;
      const bodyMetrics: Record<string, number> = {};
      for (const m of grp.measures) {
        if (m.type === WEIGHT_MEASTYPE) {
          weightKg = scale(m.value, m.unit);
          continue;
        }
        const key = BODY_METRIC_MEASTYPES[m.type];
        if (key) bodyMetrics[key] = scale(m.value, m.unit);
      }
      return {
        grpid: grp.grpid,
        date: new Date(grp.date * 1000),
        weightKg,
        bodyMetrics: Object.keys(bodyMetrics).length > 0 ? bodyMetrics : null,
      };
    });

    return groups.sort((a, b) => a.date.getTime() - b.date.getTime());
  }
}

/** Construct a `WithingsClient` from mandatory, explicit config (no env access). */
export function createWithingsClient(creds: WithingsCredentials): WithingsClient {
  return new WithingsClient(creds);
}
