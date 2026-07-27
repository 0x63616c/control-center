/**
 * Portal data-hygiene purge (www-q002.18, password-only since www-p9hx). Deletes
 * portal rows that have served their purpose so the table doesn't grow unbounded.
 * Run as a DAILY CronJob (one-shot job), NEVER a worker loop (PRD Backend rule 7).
 *
 * Retention policy:
 *  - portal_authorization: KEEP until 90 days past expiry, because a lapsed row
 *    is what drives the SessionExpired screen for a returning device; only purge
 *    well after it stops being useful.
 *
 * The portal_rate_limit singleton is self-resetting (one row, scoped to a UTC
 * day) so it needs no purge. portal_code / portal_guest / portal_attempt were
 * removed when the portal went password-only (www-p9hx).
 *
 * The delete predicate is built from an injected clock so the cutoff is
 * deterministic and testable; the count is returned (and logged by the caller).
 */
import { lt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

/** Authorizations are retained 90 days past expiry (then purged). */
export const AUTHORIZATION_GRACE_MS = 90 * 24 * 60 * 60 * 1000;

export interface PurgeCounts {
  authorizations: number;
}

/** The authorization retention cutoff for `now`. */
function authCutoff(now: Date): Date {
  return new Date(now.getTime() - AUTHORIZATION_GRACE_MS);
}

/** An authorization is purgeable once it expired more than the grace window ago. */
export function authorizationShouldPurge(row: { expiresAtUtc: Date }, now: Date): boolean {
  return row.expiresAtUtc.getTime() < authCutoff(now).getTime();
}

/** Postgres' node driver returns rowCount; treat null/undefined as 0. */
function rows(res: { rowCount?: number | null }): number {
  return res.rowCount ?? 0;
}

/**
 * Run one purge pass. Pure of any scheduling, the CronJob invokes the
 * `purge` entrypoint which calls this once and exits.
 */
export async function purgePortalData(
  db: NodePgDatabase<typeof schema>,
  now: Date = new Date(),
): Promise<PurgeCounts> {
  // Authorizations: expired more than 90 days ago.
  const authRes = await db
    .delete(schema.portalAuthorization)
    .where(lt(schema.portalAuthorization.expiresAtUtc, authCutoff(now)));

  return { authorizations: rows(authRes) };
}
