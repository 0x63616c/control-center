/**
 * Weight ingest — polls the HA Renpho BLE weight sensor and appends new
 * measurements. Deduped on TWO axes, because either alone is insufficient:
 * the measured_at unique index catches the same reading polled twice, and
 * isRepeatReading() catches an entity that re-emits an unchanged weight under a
 * fresh last_updated (which the index cannot see). The original claim here —
 * that the sensor state is simply unchanged between weigh-ins, so most cycles
 * insert nothing — held only while the entity behaved.
 * Spec: docs/superpowers/specs/2026-07-21-weight-tile-design.md.
 */

import { db as notifDb } from "@features/notif/db";
import { raiseNotification } from "@features/notif/service";
import { weightMeasurement } from "@features/weight/schema";
import {
  formatWeighInAlert,
  isOutsideSanityBand,
  isRepeatReading,
  LB_PER_KG,
  notDeleted,
} from "@features/weight/service";
import { getLogger } from "@www/logger";
import { ENV as config } from "@www/platform/env";
import { and, desc, gte, isNull } from "drizzle-orm";
import { db } from "../db/index";
import { ha } from "../integrations/homeassistant/index";
import { HaError } from "../integrations/homeassistant/types";

function newWeightId(): string {
  return `wm_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export async function runWeightIngestCycle(): Promise<void> {
  let entity: Awaited<ReturnType<typeof ha.getEntity>>;
  try {
    entity = await ha.getEntity(config.HA_WEIGHT_ENTITY_ID);
  } catch (err) {
    // 404 = the scale isn't paired in HA yet (needs a connectable BT proxy).
    // A quiet no-op, not a failing worker: the entity may not exist for days.
    if (err instanceof HaError && err.status === 404) return;
    throw err;
  }
  const raw = Number.parseFloat(entity.state);
  if (!Number.isFinite(raw)) return; // 'unknown'/'unavailable' between weigh-ins

  const unit = (entity.attributes.unit_of_measurement as string | undefined) ?? "kg";
  const weightKg = unit === "lb" ? raw / LB_PER_KG : raw;
  const measuredAt = new Date(entity.last_updated);

  // Drop a re-emission of the value we already hold. The measured_at unique
  // index cannot catch this: a flapping entity supplies a FRESH last_updated
  // with an UNCHANGED weight, so every poll would insert a phantom weigh-in.
  // See isRepeatReading() for the full signature.
  const [latest] = await db
    .select({ weightKg: weightMeasurement.weightKg })
    .from(weightMeasurement)
    .where(notDeleted())
    .orderBy(desc(weightMeasurement.measuredAt))
    .limit(1);
  if (isRepeatReading(weightKg, latest?.weightKg)) return;

  // 14-day included history feeds the sanity band.
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
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
    weightKg,
    recent.map((r) => r.weightKg),
  );

  const inserted = await db
    .insert(weightMeasurement)
    .values({
      id: newWeightId(),
      measuredAt,
      weightKg,
      bodyMetrics: null,
      source: "ha_ble",
      excludedReason: excluded ? "sanity_band" : null,
    })
    .onConflictDoNothing({ target: weightMeasurement.measuredAt })
    .returning({ id: weightMeasurement.id });
  if (inserted.length > 0) {
    getLogger().info({ weightKg, measuredAt, excluded }, "weight measurement ingested");
    const { title, body } = formatWeighInAlert(weightKg);
    try {
      await raiseNotification(notifDb, { category: "home", severity: "info", title, body });
    } catch (err) {
      getLogger().error({ err }, "failed to raise weigh-in notification");
    }
  }
}
