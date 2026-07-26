/**
 * Row-level predicate boundary tests for the portal purge (www-q002.18 hardening,
 * password-only since www-p9hx). These prove the EXACT cutoff a row is purged at,
 * so a flipped comparator or an off-by-one in the retention math fails a test
 * instead of silently deleting live data. The pure predicate helper below is the
 * single source of truth that the SQL WHERE clause mirrors 1:1.
 */

import { describe, expect, it } from "vitest";
import { AUTHORIZATION_GRACE_MS, authorizationShouldPurge } from "./jobs";

const NOW = new Date(Date.UTC(2026, 5, 10, 12, 0, 0));
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

describe("authorizationShouldPurge (90-day grace)", () => {
  it("KEEPS an authorization expired 89 days ago (still drives SessionExpired)", () => {
    expect(authorizationShouldPurge({ expiresAtUtc: daysAgo(89) }, NOW)).toBe(false);
  });
  it("DELETES an authorization expired 91 days ago", () => {
    expect(authorizationShouldPurge({ expiresAtUtc: daysAgo(91) }, NOW)).toBe(true);
  });
  it("KEEPS a still-active authorization (expires in the future)", () => {
    expect(authorizationShouldPurge({ expiresAtUtc: daysAgo(-1) }, NOW)).toBe(false);
  });
  it("boundary: exactly at the 90-day cutoff is KEPT (strictly-older purges)", () => {
    const exactly = new Date(NOW.getTime() - AUTHORIZATION_GRACE_MS);
    expect(authorizationShouldPurge({ expiresAtUtc: exactly }, NOW)).toBe(false);
  });
});
