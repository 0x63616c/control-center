// Renpho scale weigh-ins (spec: docs/superpowers/specs/2026-07-21-weight-tile-design.md),
// folded into the weight feature (Track C, Wave 2). The codegen collects every
// exported `pgTable` from a feature's schema.ts into the generated schema barrel
// (features/_generated/schema.gen.ts), which drizzle-kit reads.
//
// Raw and append-only: every HA sensor update becomes a row; nothing is ever
// deleted or collapsed. Display-layer reduces to a daily median and hides rows
// with excluded_reason set (auto sanity-band or manual toggle from the panel).
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const weightMeasurement = pgTable(
  "weight_measurement",
  {
    id: text("id").primaryKey(), // wm_<16-hex>
    // The HA sensor's last_updated for this reading. Unique = ingest idempotency
    // (the 60s poll re-sees the same state until the next weigh-in).
    measuredAt: timestamp("measured_at", { withTimezone: true }).notNull().unique(),
    // Canonical metric. lb is presentation-only.
    weightKg: doublePrecision("weight_kg").notNull(),
    // Body composition as reported (fat/muscle/water/BMR...); stored, not shown.
    bodyMetrics: jsonb("body_metrics"),
    source: text("source").notNull(), // 'ha_ble' | 'withings_api'
    // Withings' own measurement-group id (direct-API ingest only; null for
    // HA-sourced rows). Unique so a correction Calum makes in the Health Mate
    // app , same grpid, edited value , updates the row via onConflictDoUpdate
    // instead of being silently dropped by the measured_at conflict target.
    withingsGrpid: text("withings_grpid").unique(),
    // Non-null = hidden from all reads. 'sanity_band' (auto) | 'manual'.
    excludedReason: text("excluded_reason"),
    // Tombstone. A hard DELETE is not safe: ingest re-sees the same HA sensor
    // state on its next poll and re-inserts the row, because the measured_at
    // unique index is the only thing stopping it.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("weight_measurement_measured_at_idx").on(t.measuredAt)],
);

// Singleton row: this integration has exactly one Withings account, so there is
// exactly one token/cursor row rather than a keyed-by-user table.
export const WITHINGS_OAUTH_TOKEN_SINGLETON_ID = "singleton";

export const withingsOauthToken = pgTable("withings_oauth_token", {
  id: text("id").primaryKey(),
  accessToken: text("access_token").notNull(),
  // Withings ROTATES this on every refresh call , the ingest cycle must persist
  // a refresh's result with an optimistic lock (WHERE refresh_token = <value
  // read at cycle start>) before using the new access token. Two independent
  // consumers refreshing off the same lineage will otherwise eventually strand
  // each other with invalid_grant.
  refreshToken: text("refresh_token").notNull(),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }).notNull(),
  // Withings' own numeric userid, echoed on every oauth2 response , a cheap
  // sanity check that a refresh didn't somehow hand back a different account.
  withingsUserId: text("withings_user_id").notNull(),
  // Incremental-sync cursor for GET /measure?action=getmeas&lastupdate=. Unix
  // seconds, stored as-is (not timestamptz) so it round-trips through the
  // Withings API without a tz conversion at the boundary.
  lastMeasUpdate: integer("last_meas_update").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
