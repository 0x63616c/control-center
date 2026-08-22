// Withings scale weigh-ins, pulled straight from Withings' cloud API (spec:
// docs/superpowers/specs/2026-07-21-weight-tile-design.md), folded into the
// weight feature (Track C, Wave 2). The codegen collects every exported
// `pgTable` from a feature's schema.ts into the generated schema barrel
// (features/_generated/schema.gen.ts), which drizzle-kit reads.
//
// Raw and append-only: every ingested measurement becomes a row; nothing is
// ever deleted or collapsed. Display-layer reduces to a daily median and
// hides rows with excluded_reason set (auto sanity-band or manual toggle from
// the panel).
//
// One named exception: the ha_ble-sourced rows (Renpho scale over a BLE
// proxy, polled via Home Assistant) were hard-deleted in migration 0033 (#251)
// once that ingest path was retired (#245) and could no longer re-insert them.
// That was a one-time purge of a decommissioned source's historical data, not
// a reversal of append-only for the live withings_api path.
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
    // Panel corrections are overlays, not rewrites of the Withings payload.
    // Keeping the reported value intact means a later source re-sync cannot
    // silently erase a correction and leaves the original evidence available.
    manualWeightKg: doublePrecision("manual_weight_kg"),
    // Body composition as reported (fat/muscle/hydration/bone/fat-free), keyed
    // by the names in WEIGHT_METRICS. Null whenever a Withings sync didn't
    // include bio-impedance (e.g. socks/shoes on, or a failed impedance read) ,
    // a weight-only sync is a real, expected shape, not an error.
    bodyMetrics: jsonb("body_metrics").$type<Record<string, number>>(),
    // Per-key overlay on bodyMetrics. A number replaces the reported value;
    // JSON null deliberately clears only that metric. Unmentioned keys keep
    // following Withings, including metrics added by a later sync.
    manualBodyMetricOverrides: jsonb("manual_body_metric_overrides").$type<
      Record<string, number | null>
    >(),
    source: text("source").notNull(), // always 'withings_api'; the ha_ble rows were purged in #251
    // Withings' own measurement-group id (direct-API ingest only; null for
    // HA-sourced rows). Unique so a correction Calum makes in the Health Mate
    // app , same grpid, edited value , updates the row via onConflictDoUpdate
    // instead of being silently dropped by the measured_at conflict target.
    withingsGrpid: text("withings_grpid").unique(),
    // Non-null = hidden from all reads. 'sanity_band' (auto) | 'manual'.
    excludedReason: text("excluded_reason"),
    // Tombstone for reads that need a reversible hide (e.g. a manual/
    // sanity-band exclusion review flow). This is distinct from a hard
    // DELETE: with a live poller in front of a row, a hard DELETE isn't safe
    // because ingest can re-see the same source state on its next cycle and
    // re-insert it, with only the measured_at unique index stopping it. That
    // specific hazard is what made deletedAt necessary for the old ha_ble
    // poller; migration 0033 (#251) hard-deletes those rows directly instead,
    // which is safe now that the ha_ble writer itself is gone (#245).
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
