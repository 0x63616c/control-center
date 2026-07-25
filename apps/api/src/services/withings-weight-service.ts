/**
 * Withings direct-API weight ingest , polls Withings' cloud API directly
 * (bypassing HA's 10min-poll integration entirely) so a weigh-in lands within
 * ~30s end-to-end. Owns the OAuth relationship: refreshes the access token
 * when it's near expiry and persists the rotated pair with an optimistic
 * lock, because Withings rotates the refresh_token on every use , see
 * withingsOauthToken's doc comment in features/weight/schema.ts for why a
 * second independent refresher (e.g. HA's own integration, left running)
 * would eventually strand this one.
 *
 * Inert until withings_oauth_token is seeded by the activation runbook (a
 * one-time token extraction from HA's storage) , a missing row is a quiet
 * no-op, not a failing worker.
 *
 * Spec: docs/superpowers/specs/2026-07-21-weight-tile-design.md.
 */

import { db as notifDb } from "@features/notif/db";
import { raiseNotification } from "@features/notif/service";
import {
  WITHINGS_OAUTH_TOKEN_SINGLETON_ID,
  weightMeasurement,
  withingsOauthToken,
} from "@features/weight/schema";
import { formatWeighInAlert, isOutsideSanityBand, notDeleted } from "@features/weight/service";
import { getLogger, logChange } from "@www/logger";
import { and, eq, gte, isNull } from "drizzle-orm";
import { db } from "../db/index";
import { withings } from "../integrations/withings";

// Refresh 60s before the access token actually expires so an in-flight cycle
// never hits a stale token (mirrors SpotifyClient's EXPIRY_BUFFER_MS).
const EXPIRY_BUFFER_MS = 60_000;
const SANITY_BAND_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function newWeightId(): string {
  return `wm_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export async function runWithingsWeightIngestCycle(): Promise<void> {
  if (!withings.isConfigured()) return;

  const [row] = await db
    .select()
    .from(withingsOauthToken)
    .where(eq(withingsOauthToken.id, WITHINGS_OAUTH_TOKEN_SINGLETON_ID))
    .limit(1);
  if (!row) {
    // Expected state until the activation runbook seeds the token , not an
    // error, just nothing to do yet. logChange because this cycle runs every
    // 10s: as a raw warn it was ~8,600 lines/day of a state that is not going
    // to change on its own, which drowns the info stream it sits in.
    logChange(
      getLogger(),
      "withings-token-unseeded",
      {},
      "withings oauth token not seeded, skipping cycle",
      { level: "warn" },
    );
    return;
  }

  let accessToken = row.accessToken;

  if (row.accessTokenExpiresAt.getTime() - Date.now() < EXPIRY_BUFFER_MS) {
    const rotated = await withings.refreshToken(row.refreshToken);
    const updated = await db
      .update(withingsOauthToken)
      .set({
        accessToken: rotated.accessToken,
        refreshToken: rotated.refreshToken,
        accessTokenExpiresAt: rotated.expiresAt,
        withingsUserId: rotated.withingsUserId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(withingsOauthToken.id, WITHINGS_OAUTH_TOKEN_SINGLETON_ID),
          // Optimistic lock: only persist if nothing else rotated the token
          // out from under us since we read it above. A miss means a
          // concurrent refresh already happened , the pair we're about to use
          // may already be stale, so fail loudly rather than strand the
          // account on an unusable refresh_token.
          eq(withingsOauthToken.refreshToken, row.refreshToken),
        ),
      )
      .returning({ id: withingsOauthToken.id });
    if (updated.length === 0) {
      getLogger().error(
        {},
        "withings token refresh raced a concurrent rotation, refusing to proceed",
      );
      throw new Error("withings oauth token optimistic lock failed");
    }
    accessToken = rotated.accessToken;
  }

  const groups = await withings.getMeasurementsSince(accessToken, row.lastMeasUpdate);
  if (groups.length === 0) return;

  let newCursor = row.lastMeasUpdate;
  for (const group of groups) {
    newCursor = Math.max(newCursor, Math.floor(group.date.getTime() / 1000));
    if (group.weightKg == null) continue;

    const grpid = String(group.grpid);
    const [existing] = await db
      .select({ id: weightMeasurement.id })
      .from(weightMeasurement)
      .where(eq(weightMeasurement.withingsGrpid, grpid))
      .limit(1);
    const isNewReading = existing == null;

    const cutoff = new Date(Date.now() - SANITY_BAND_WINDOW_MS);
    const recent = await db
      .select({ weightKg: weightMeasurement.weightKg })
      .from(weightMeasurement)
      .where(
        and(
          isNull(weightMeasurement.excludedReason),
          notDeleted(),
          gte(weightMeasurement.measuredAt, cutoff),
        ),
      );
    const excluded = isOutsideSanityBand(
      group.weightKg,
      recent.map((r) => r.weightKg),
    );

    await db
      .insert(weightMeasurement)
      .values({
        id: newWeightId(),
        measuredAt: group.date,
        weightKg: group.weightKg,
        bodyMetrics: group.bodyMetrics,
        source: "withings_api",
        withingsGrpid: grpid,
        excludedReason: excluded ? "sanity_band" : null,
      })
      .onConflictDoUpdate({
        target: weightMeasurement.withingsGrpid,
        set: {
          weightKg: group.weightKg,
          bodyMetrics: group.bodyMetrics,
          excludedReason: excluded ? "sanity_band" : null,
        },
      });

    if (isNewReading) {
      getLogger().info(
        { weightKg: group.weightKg, measuredAt: group.date, excluded },
        "weight measurement ingested (withings)",
      );
      const { title, body } = formatWeighInAlert(group.weightKg);
      try {
        await raiseNotification(notifDb, { category: "home", severity: "info", title, body });
      } catch (err) {
        getLogger().error({ err }, "failed to raise weigh-in notification");
      }
    }
  }

  if (newCursor !== row.lastMeasUpdate) {
    await db
      .update(withingsOauthToken)
      .set({ lastMeasUpdate: newCursor, updatedAt: new Date() })
      .where(eq(withingsOauthToken.id, WITHINGS_OAUTH_TOKEN_SINGLETON_ID));
  }
}
