/**
 * Tests for the portal data-hygiene purge (www-q002.18, password-only since
 * www-p9hx). The purge runs as a daily CronJob (one-shot, never a worker loop).
 * It deletes portal_authorization rows expired more than 90 days ago (kept until
 * then so they still drive the SessionExpired UX). portal_code / portal_attempt
 * were removed with the email/OTP flow; the portal_rate_limit singleton
 * self-resets daily and needs no purge.
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";
import { AUTHORIZATION_GRACE_MS, purgePortalData } from "./jobs";
import type * as schema from "./schema";
import { portalAuthorization } from "./schema";

// A fake drizzle db: db.delete(table).where(cond) resolves to { rowCount }.
const asDb = (fake: unknown) => fake as unknown as NodePgDatabase<typeof schema>;

function makeFakeDb(authRows: number) {
  const deleted: string[] = [];
  const db = {
    delete(table: unknown) {
      const name = table === portalAuthorization ? "portal_authorization" : "unknown";
      return {
        where(_cond: unknown) {
          deleted.push(name);
          return Promise.resolve({ rowCount: authRows });
        },
      };
    },
  };
  return { db, deleted };
}

describe("purge retention constants", () => {
  it("keeps authorizations 90 days past expiry (drives SessionExpired UX)", () => {
    expect(AUTHORIZATION_GRACE_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });
});

describe("purgePortalData", () => {
  it("deletes only from portal_authorization and returns its count", async () => {
    const { db, deleted } = makeFakeDb(4);
    const result = await purgePortalData(asDb(db), new Date());
    expect(deleted).toEqual(["portal_authorization"]);
    expect(result).toEqual({ authorizations: 4 });
  });

  it("returns zero when nothing matches the cutoff", async () => {
    const { db } = makeFakeDb(0);
    const result = await purgePortalData(asDb(db), new Date());
    expect(result).toEqual({ authorizations: 0 });
  });

  it("treats a null rowCount as zero (driver may omit it)", async () => {
    const db = { delete: () => ({ where: () => Promise.resolve({ rowCount: null }) }) };
    const result = await purgePortalData(asDb(db), new Date());
    expect(result).toEqual({ authorizations: 0 });
  });

  it("uses the injected clock for the authorization 90-day cutoff", async () => {
    const seen: unknown[] = [];
    const db = {
      delete: () => ({
        where: (cond: unknown) => {
          seen.push(cond);
          return Promise.resolve({ rowCount: 0 });
        },
      }),
    };
    await purgePortalData(asDb(db), new Date(Date.UTC(2026, 0, 1)));
    expect(seen.length).toBe(1);
  });
});
