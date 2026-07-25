// Renpho scale weigh-ins (spec: docs/superpowers/specs/2026-07-21-weight-tile-design.md),
// folded into the weight feature (Track C, Wave 2). The codegen collects every
// exported `pgTable` from a feature's schema.ts into the generated schema barrel
// (features/_generated/schema.gen.ts), which drizzle-kit reads.
//
// Raw and append-only: every HA sensor update becomes a row; nothing is ever
// deleted or collapsed. Display-layer reduces to a daily median and hides rows
// with excluded_reason set (auto sanity-band or manual toggle from the panel).
import { doublePrecision, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
    source: text("source").notNull(), // 'ha_ble'
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
