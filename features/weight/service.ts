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
import { weightMeasurement } from "./schema";

const SANITY_BAND_KG = 5.4; // 12 lb
export const LB_PER_KG = 2.2046226218;

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

/**
 * True when a polled reading is the SAME measurement we already stored, and so
 * must not be inserted again.
 *
 * WHY THIS IS NOT THE UNIQUE INDEX'S JOB: ingest dedupes on `measured_at`, which
 * is the HA entity's `last_updated`. That only holds while the entity is quiet
 * between weigh-ins. A flapping entity re-emits an UNCHANGED weight with a FRESH
 * `last_updated`, which sails through the unique index and lands a phantom
 * weigh-in on every poll. The Renpho scale did exactly this: bit-identical
 * `72.55000000160527` from 2026-07-23 03:00 onward, plus one more the instant HA
 * restarted on 2026-07-24. Those rows pollute History and drag the 14-day median
 * that isOutsideSanityBand() bands against.
 *
 * Compares EXACTLY, with no epsilon, deliberately. The failure mode is a sensor
 * repeating a value verbatim, so exact equality catches every phantom while being
 * incapable of suppressing a genuinely different reading. The residual cost is a
 * real weigh-in landing on the identical float as the previous one — for a BLE
 * scale carrying noise in the low decimals that is vanishingly unlikely, and it
 * would record the same weight we already have.
 */
export function isRepeatReading(weightKg: number, latestStoredKg: number | undefined): boolean {
  return latestStoredKg !== undefined && weightKg === latestStoredKg;
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

const RANGE_DAYS = { "7d": 7, "30d": 30, all: null } as const;

interface DayRow {
  id: string;
  day: string;
  measuredAt: Date;
  weightKg: number;
  excludedReason: string | null;
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
        r.excludedReason == null && prevIncludedKg != null ? r.weightKg - prevIncludedKg : null;
      if (r.excludedReason == null) prevIncludedKg = r.weightKg;
      return {
        id: r.id,
        measuredAt: r.measuredAt.toISOString(),
        weightKg: r.weightKg,
        excludedReason: r.excludedReason,
        deltaKg,
      };
    });
    return {
      day,
      // null, not NaN, when every reading that day was excluded — median([])
      // is NaN, and there is no superjson transformer on this router, so a
      // NaN would silently serialise to `null` while the type still claimed
      // `number` and the client would render "0.0 lb".
      medianKg: included.length ? median(included.map((r) => r.weightKg)) : null,
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
// the first included reading exists (day-one skeleton).
export async function getSummary(range: "7d" | "30d" | "all", tz: string) {
  const days = RANGE_DAYS[range];
  const cutoff = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;
  const rows = await db
    .select({
      day: dayExpr(tz),
      weightKg: weightMeasurement.weightKg,
    })
    .from(weightMeasurement)
    .where(
      and(
        isNull(weightMeasurement.excludedReason),
        notDeleted(),
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
      excludedReason: weightMeasurement.excludedReason,
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

// Tombstone, never a hard DELETE: ingest re-inserts any row it can still see
// in the HA sensor's current state (weight-service.ts, apps/api). Returns
// whether a row was actually tombstoned; api.ts throws NOT_FOUND on false.
export async function deleteReading(id: string): Promise<boolean> {
  const [deleted] = await db
    .update(weightMeasurement)
    .set({ deletedAt: new Date() })
    .where(and(eq(weightMeasurement.id, id), notDeleted()))
    .returning({ id: weightMeasurement.id });
  return deleted != null;
}
