/**
 * Weight domain math, SQL predicates, and query bodies (Track C, Wave 2 fold).
 * Merges the pre-fold apps/api/src/services/weight-domain.ts and
 * weight-sql.ts plus the four query bodies that used to live inline in
 * apps/api/src/trpc/routers/weight.ts, now against this feature's own db.
 * Spec: docs/superpowers/specs/2026-07-21-weight-tile-design.md.
 */
import type { SQL } from "drizzle-orm";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { BODY_METRIC_KEYS, WEIGHT_METRICS, type WeightMetric } from "./metrics";
import { weightMeasurement } from "./schema";

const SANITY_BAND_KG = 5.4; // 12 lb
const LB_PER_KG = 2.2046226218;

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const upper = s[mid];
  const lower = s[mid - 1];
  if (upper === undefined) return Number.NaN;
  return s.length % 2 || lower === undefined ? upper : (lower + upper) / 2;
}

/** Notification copy for a freshly-ingested weigh-in. */
export function formatWeighInAlert(weightKg: number): { title: string; body: string } {
  const lb = (weightKg * LB_PER_KG).toFixed(1);
  return { title: `New weight logged: ${lb}lbs`, body: "" };
}

/** Band is inactive until 3 included readings exist (first-days bootstrap). */
export function isOutsideSanityBand(kg: number, recentIncludedKg: number[]): boolean {
  if (recentIncludedKg.length < 3) return false;
  return Math.abs(kg - median(recentIncludedKg)) > SANITY_BAND_KG;
}

/** A reading already bucketed into a local calendar day by the caller. */
export interface DayKeyedRow {
  /** YYYY-MM-DD in the requesting client's timezone. */
  day: string;
  weightKg: number;
}

export function dailyMedians(rows: DayKeyedRow[]): { day: string; kg: number }[] {
  const byDay = new Map<string, number[]>();
  for (const r of rows) {
    const kgs = byDay.get(r.day);
    if (kgs) kgs.push(r.weightKg);
    else byDay.set(r.day, [r.weightKg]);
  }
  return [...byDay.entries()]
    .map(([day, kgs]) => ({ day, kg: median(kgs) }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Window statistics. The two input sets are deliberate, not an oversight:
 *
 * - low/high come from RAW readings, because they are read as "the lightest
 *   and heaviest I have been", and a median can never be either.
 * - average/change come from DAILY MEDIANS, so a day weighed four times does
 *   not outvote a day weighed once, and change stays a day-over-day trend
 *   rather than the gap between two arbitrary weigh-ins.
 */
export function summarize(
  daily: { day: string; kg: number }[],
  rawKg: number[],
): { low: number; high: number; average: number; change: number } | null {
  const kgs = daily.map((d) => d.kg);
  const first = kgs[0];
  const last = kgs[kgs.length - 1];
  if (first === undefined || last === undefined || rawKg.length === 0) return null;
  return {
    low: Math.min(...rawKg),
    high: Math.max(...rawKg),
    average: kgs.reduce((a, b) => a + b, 0) / kgs.length,
    change: last - first,
  };
}

/**
 * Local calendar day of a reading, as YYYY-MM-DD in the caller's zone.
 *
 * WARNING: call this once per query and reuse the result. Postgres matches
 * SELECT DISTINCT / GROUP BY against ORDER BY by expression equality, but each
 * call to dayExpr() binds its own copy of `tz` as a separate parameter — so a
 * second call in the same statement (e.g. repeating it in ORDER BY instead of
 * ordering by the SELECT list's column position) produces two expressions
 * Postgres considers different, and it rejects the query with 42P10.
 */
export function dayExpr(tz: string): SQL<string> {
  return sql<string>`to_char(${weightMeasurement.measuredAt} AT TIME ZONE ${tz}, 'YYYY-MM-DD')`;
}

/** Tombstoned rows are invisible to every read. */
export function notDeleted() {
  return isNull(weightMeasurement.deletedAt);
}

/** True when Intl recognises the name, which is what Postgres also accepts. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The panel states its own zone; the api never infers one. */
export const tzInput = z.string().refine(isValidTimeZone, {
  message: "not a recognised IANA time zone",
});

/**
 * The plottable series. `weight_kg` is its own column; every other metric is a
 * key inside the `body_metrics` jsonb Withings reports alongside the weight.
 *
 * `unit` drives presentation end-to-end: "kg" values are converted to lb at the
 * web boundary (the panel speaks lb for body mass), "percent" values are NOT —
 * a fat ratio has no lb equivalent and multiplying it by 2.2 would be nonsense.
 */
export const metricInput = z.enum(Object.keys(WEIGHT_METRICS) as [WeightMetric, ...WeightMetric[]]);
export const bodyMetricInput = z.enum(BODY_METRIC_KEYS);

const editedBodyMetricValueInput = z.number().finite().nonnegative().max(500).nullable();

export const editReadingInput = z
  .object({
    id: z.string(),
    weightKg: z.number().finite().min(1).max(500).optional(),
    bodyMetrics: z.partialRecord(bodyMetricInput, editedBodyMetricValueInput).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.weightKg === undefined && Object.keys(input.bodyMetrics ?? {}).length === 0) {
      ctx.addIssue({ code: "custom", message: "at least one measurement change is required" });
    }
    const fat = input.bodyMetrics?.fat_ratio_percent;
    if (fat != null && fat > 100) {
      ctx.addIssue({
        code: "custom",
        path: ["bodyMetrics", "fat_ratio_percent"],
        message: "fat percentage must be at most 100",
      });
    }
  });

/**
 * The value being plotted, as a SQL expression. Body-composition metrics live
 * in jsonb, so they need an explicit ->> + cast; weight is a real column.
 */
export function metricExpr(metric: WeightMetric): SQL<number> {
  if (metric === "weight_kg") {
    return sql<number>`coalesce(${weightMeasurement.manualWeightKg}, ${weightMeasurement.weightKg})`;
  }
  return sql<number>`case
    when ${weightMeasurement.manualBodyMetricOverrides} ? ${metric}
      then (${weightMeasurement.manualBodyMetricOverrides} ->> ${metric})::double precision
    else (${weightMeasurement.bodyMetrics} ->> ${metric})::double precision
  end`;
}

const RANGE_DAYS = { "7d": 7, "30d": 30, all: null } as const;

interface DayRow {
  id: string;
  day: string;
  measuredAt: Date;
  weightKg: number;
  manualWeightKg?: number | null;
  excludedReason: string | null;
  /** Withings body composition; absent/null for a weight-only sync. */
  bodyMetrics?: Record<string, number> | null;
  manualBodyMetricOverrides?: Record<string, number | null> | null;
}

export function applyBodyMetricOverrides(
  reported: Record<string, number> | null | undefined,
  overrides: Record<string, number | null> | null | undefined,
): Record<string, number> | null {
  const effective = { ...(reported ?? {}) };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === null) delete effective[key];
    else effective[key] = value;
  }
  return Object.keys(effective).length > 0 ? effective : null;
}

/**
 * Rows (newest first, already day-keyed) → day groups.
 *
 * The day median counts only included readings — that is the number the trend
 * line plots — while the reading list shows everything so an auto-flagged
 * outlier stays visible and reversible. dayDeltaKg compares against the
 * previous RECORDED day, which with a gap in weigh-ins spans more than 24h.
 */
export function assembleDays(rows: DayRow[]) {
  const order: string[] = [];
  const byDay = new Map<string, DayRow[]>();
  for (const r of rows) {
    const existing = byDay.get(r.day);
    if (existing) existing.push(r);
    else {
      byDay.set(r.day, [r]);
      order.push(r.day);
    }
  }

  const days = order.map((day) => {
    const dayRows = byDay.get(day) ?? [];
    const included = dayRows.filter((r) => r.excludedReason == null);
    // Deltas compare against the previous OLDER included reading, so walk the
    // day oldest-first and reverse back.
    const oldestFirst = [...dayRows].reverse();
    let prevIncludedKg: number | null = null;
    const withDeltas = oldestFirst.map((r) => {
      const deltaKg =
        r.excludedReason == null && prevIncludedKg != null
          ? (r.manualWeightKg ?? r.weightKg) - prevIncludedKg
          : null;
      const effectiveWeightKg = r.manualWeightKg ?? r.weightKg;
      if (r.excludedReason == null) prevIncludedKg = effectiveWeightKg;
      return {
        id: r.id,
        measuredAt: r.measuredAt.toISOString(),
        weightKg: effectiveWeightKg,
        excludedReason: r.excludedReason,
        deltaKg,
        bodyMetrics: applyBodyMetricOverrides(r.bodyMetrics, r.manualBodyMetricOverrides),
      };
    });
    return {
      day,
      // null, not NaN, when every reading that day was excluded — median([])
      // is NaN, and there is no superjson transformer on this router, so a
      // NaN would silently serialise to `null` while the type still claimed
      // `number` and the client would render "0.0 lb".
      medianKg: included.length
        ? median(included.map((r) => r.manualWeightKg ?? r.weightKg))
        : null,
      readings: withDeltas.reverse(),
    };
  });

  return days.map((d, i) => {
    const older = days[i + 1];
    const dMedian = d.medianKg;
    const olderMedian = older?.medianKg;
    const dayDeltaKg = dMedian != null && olderMedian != null ? dMedian - olderMedian : null;
    return { ...d, dayDeltaKg };
  });
}

// Daily-median series + window stats for the tile and Trend page. Null until
// the first included reading exists (day-one skeleton). `metric` selects which
// series is plotted. The ha_ble rows that used to force a Withings-only
// filter here (so switching metrics didn't jump the window's start date) were
// purged in migration 0033 (#251); `source` is now always 'withings_api', so
// there is nothing left to filter out. This is an implicit property of the
// data rather than an enforced invariant , nothing currently guards against a
// future non-withings source re-entering these rows with a different start
// date than the rest.
export async function getSummary(
  range: "7d" | "30d" | "all",
  tz: string,
  metric: WeightMetric = "weight_kg",
) {
  const days = RANGE_DAYS[range];
  const cutoff = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;
  const value = metricExpr(metric);
  const rows = await db
    .select({
      day: dayExpr(tz),
      weightKg: value,
    })
    .from(weightMeasurement)
    .where(
      and(
        isNull(weightMeasurement.excludedReason),
        notDeleted(),
        // A Withings row can still lack a given body-composition key (a
        // weight-only sync, or a metric the scale didn't report that session).
        // Those must drop out of the series rather than land as nulls that
        // median() would turn into NaN.
        sql`${value} is not null`,
        ...(cutoff ? [gte(weightMeasurement.measuredAt, cutoff)] : []),
      ),
    )
    .orderBy(weightMeasurement.measuredAt);
  if (rows.length === 0) return null;

  const daily = dailyMedians(rows);
  const s = summarize(
    daily,
    rows.map((r) => r.weightKg),
  );
  if (!s) return null;
  const latestDay = daily[daily.length - 1];
  if (!latestDay) return null;
  // A monotonic freshness token for the panel: MAX(measured_at) over all
  // live rows (exclusion-independent, so an on-ingest sanity-band exclusion
  // still advances it). The Readings list can't safely poll (its cursors
  // are frozen day-strings), so it watches this instead and invalidates
  // only when a genuinely new reading has landed.
  const [latest] = await db
    .select({ at: sql<string | null>`max(${weightMeasurement.measuredAt})::text` })
    .from(weightMeasurement)
    .where(notDeleted());
  return {
    // The hero number is the latest DAY's median, so it agrees with the
    // chart and the average. It used to be the latest raw reading, which
    // disagreed with every other number on the page.
    latestKg: latestDay.kg,
    latestDay: latestDay.day,
    latestMeasuredAt: latest?.at ?? null,
    daily,
    ...s,
  };
}

// One page of days, newest first, for the Readings page. Two queries so a
// page boundary can never split a day in half: pick the days, then fetch
// every reading belonging to them.
export async function getDays(tz: string, cursor: string | undefined, limit: number) {
  const day = dayExpr(tz);
  const dayRows = await db
    .selectDistinct({ day })
    .from(weightMeasurement)
    .where(and(notDeleted(), ...(cursor ? [lt(day, cursor)] : [])))
    // Order by ORDINAL, not by repeating the expression. dayExpr() binds tz
    // as a parameter and is rendered independently per clause, so the SELECT
    // list gets $1 and an ORDER BY copy would get $4 — and Postgres matches
    // SELECT DISTINCT against ORDER BY by expression equality, where
    // Param(1) != Param(4). Repeating it raises 42P10 on every call.
    .orderBy(sql`1 desc`)
    .limit(limit + 1);

  // The extra row tells us whether another page exists without a count(*),
  // AND doubles as delta context: without it, the oldest day of every page
  // would have nothing to compare against and lose its day-over-day delta
  // forever once the next page loads separately.
  const hasMore = dayRows.length > limit;
  const pageDays = dayRows.slice(0, limit).map((d) => d.day);
  if (pageDays.length === 0) return { days: [], nextCursor: null };
  const contextDay = hasMore ? dayRows[limit]?.day : undefined;
  const queryDays = contextDay ? [...pageDays, contextDay] : pageDays;

  const rows = await db
    .select({
      id: weightMeasurement.id,
      day,
      measuredAt: weightMeasurement.measuredAt,
      weightKg: weightMeasurement.weightKg,
      manualWeightKg: weightMeasurement.manualWeightKg,
      excludedReason: weightMeasurement.excludedReason,
      bodyMetrics: weightMeasurement.bodyMetrics,
      manualBodyMetricOverrides: weightMeasurement.manualBodyMetricOverrides,
    })
    .from(weightMeasurement)
    .where(and(notDeleted(), inArray(day, queryDays)))
    .orderBy(desc(weightMeasurement.measuredAt));

  const assembled = assembleDays(rows);
  // The context day, if fetched, is the oldest and so always assembles
  // last — drop it now that it has done its job of giving the last real
  // page day a delta.
  const outDays = contextDay ? assembled.slice(0, -1) : assembled;

  return {
    days: outDays,
    nextCursor: hasMore ? (pageDays[pageDays.length - 1] ?? null) : null,
  };
}

// Manual include/exclude toggle from the Readings page; overrides the
// auto sanity-band flag in both directions.
export async function setExcluded(id: string, excluded: boolean): Promise<void> {
  await db
    .update(weightMeasurement)
    .set({ excludedReason: excluded ? "manual" : null })
    .where(and(eq(weightMeasurement.id, id), notDeleted()));
}

export async function editReading(input: z.infer<typeof editReadingInput>): Promise<boolean> {
  const [current] = await db
    .select({ overrides: weightMeasurement.manualBodyMetricOverrides })
    .from(weightMeasurement)
    .where(and(eq(weightMeasurement.id, input.id), notDeleted()))
    .limit(1);
  if (!current) return false;

  const nextOverrides = input.bodyMetrics
    ? { ...(current.overrides ?? {}), ...input.bodyMetrics }
    : undefined;
  await db
    .update(weightMeasurement)
    .set({
      ...(input.weightKg === undefined ? {} : { manualWeightKg: input.weightKg }),
      ...(nextOverrides === undefined ? {} : { manualBodyMetricOverrides: nextOverrides }),
    })
    .where(and(eq(weightMeasurement.id, input.id), notDeleted()));
  return true;
}

// Tombstone, never a hard DELETE: a correction Calum makes in the Health Mate
// app re-syncs the same grpid and would otherwise resurrect the row via
// onConflictDoUpdate (withings-weight-service.ts, apps/api). Returns whether a
// row was actually tombstoned; api.ts throws NOT_FOUND on false.
export async function deleteReading(id: string): Promise<boolean> {
  const [deleted] = await db
    .update(weightMeasurement)
    .set({ deletedAt: new Date() })
    .where(and(eq(weightMeasurement.id, id), notDeleted()))
    .returning({ id: weightMeasurement.id });
  return deleted != null;
}

/** Canonical included measurements for cross-feature timelines; manual edits apply here too. */
export async function getTimeline(from: string, to: string) {
  const rows = await db
    .select({
      id: weightMeasurement.id,
      at: weightMeasurement.measuredAt,
      kg: metricExpr("weight_kg"),
    })
    .from(weightMeasurement)
    .where(
      and(
        notDeleted(),
        isNull(weightMeasurement.excludedReason),
        gte(weightMeasurement.measuredAt, new Date(from)),
        lt(weightMeasurement.measuredAt, new Date(to)),
      ),
    )
    .orderBy(weightMeasurement.measuredAt);
  return rows.map((row) => ({ ...row, at: row.at.toISOString() }));
}
