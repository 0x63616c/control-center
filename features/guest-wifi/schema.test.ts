/**
 * Tests for the captive-portal domain schema (www-q002.8, password-only since
 * www-p9hx). Verifies table shape, column names, constraints (primaryKey,
 * uniqueIndex), and default values via Drizzle introspection. No DB connection
 * needed , all checks use static schema metadata.
 */

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { PORTAL_RATE_LIMIT_ID, portalAuthorization, portalRateLimit } from "./schema";

// Helper: find a column config by its SQL column name.
function col(table: ReturnType<typeof getTableConfig>, name: string) {
  const c = table.columns.find((c) => c.name === name);
  if (!c) throw new Error(`Column '${name}' not found in ${table.name}`);
  return c;
}

describe("portal_rate_limit table schema", () => {
  it("has expected column names", () => {
    const cols = Object.keys(portalRateLimit);
    for (const name of ["id", "dateUtc", "wrongAttempts", "updatedAtUtc"]) {
      expect(cols).toContain(name);
    }
  });

  it("id is the primary key (singleton)", () => {
    const cfg = getTableConfig(portalRateLimit);
    expect(col(cfg, "id").primary).toBe(true);
  });

  it("wrong_attempts defaults to 0", () => {
    const cfg = getTableConfig(portalRateLimit);
    const c = col(cfg, "wrong_attempts");
    expect(c.hasDefault).toBe(true);
    expect(c.default).toBe(0);
  });

  it("required fields are notNull", () => {
    const cfg = getTableConfig(portalRateLimit);
    for (const name of ["id", "date_utc", "wrong_attempts", "updated_at_utc"]) {
      expect(col(cfg, name).notNull).toBe(true);
    }
  });

  it("exports the constant singleton id", () => {
    expect(PORTAL_RATE_LIMIT_ID).toBe("global");
  });
});

describe("portal_authorization table schema (mac-only)", () => {
  it("has expected column names and NO guestId", () => {
    const cols = Object.keys(portalAuthorization);
    for (const name of ["id", "mac", "grantedAtUtc", "expiresAtUtc"]) {
      expect(cols).toContain(name);
    }
    expect(cols).not.toContain("guestId");
  });

  it("id is the primary key", () => {
    const cfg = getTableConfig(portalAuthorization);
    expect(col(cfg, "id").primary).toBe(true);
  });

  it("mac has a unique index (one authorization row per device , idempotent upsert)", () => {
    const cfg = getTableConfig(portalAuthorization);
    const uniques = cfg.indexes.filter((i) => i.config?.unique === true);
    const names = uniques.map((i) => i.config?.name);
    expect(names).toContain("portal_authorization_mac_idx");
  });

  it("has no foreign keys (guest concept removed)", () => {
    const cfg = getTableConfig(portalAuthorization);
    expect(cfg.foreignKeys.length).toBe(0);
  });

  it("required fields are notNull", () => {
    const cfg = getTableConfig(portalAuthorization);
    for (const name of ["id", "mac", "granted_at_utc", "expires_at_utc"]) {
      expect(col(cfg, name).notNull).toBe(true);
    }
  });
});
