/**
 * Weight tile — live wiring for its two detail-page variants: "Trend"
 * (WeightPageView — range picker + chart + window stats) and "Readings"
 * (WeightReadingsView — day groups with per-reading actions).
 *
 * This layer is the presentation boundary: it states the panel's timezone on
 * every query (the api never infers one), and converts kg→lb (the views speak
 * lb only). Day grouping and all statistics happen server-side.
 */

import { formatRecency, LB_PER_KG } from "@features/weight/web";
import { keepPreviousData } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WeightMetricValue, WeightRange, WeightUnit } from "@/components/tiles/WeightPageView";
import { WeightPageView } from "@/components/tiles/WeightPageView";
import type { WeightReadingDay } from "@/components/tiles/WeightReadingsView";
import { WeightReadingsView } from "@/components/tiles/WeightReadingsView";
import { TileStatus } from "@/components/ui";
import { POLL, useNow } from "@/lib/hooks";
import { formatDateKey, formatInTimeZone, useTimeZone } from "@/lib/time-zone";
import type { RouterOutputs } from "@/lib/trpc";
import { trpc } from "@/lib/trpc";
import type { DetailVariant, TileDetailPageEntry } from "../types";

/** "Jun 22 – Today" for the chart's bottom-right window label. */
function windowLabelOf(daily: { day: string }[], now: Date, timeZone: string): string | null {
  const first = daily[0];
  const lastDay = daily[daily.length - 1];
  if (!first || !lastDay) return null;
  const fmt = (day: string) =>
    // day is a local YYYY-MM-DD; parse as local midnight, not UTC.
    formatDateKey(day, { month: "short", day: "numeric" });
  const end = formatRecency(lastDay.day, now, timeZone);
  return `${fmt(first.day)} – ${end}`;
}

/**
 * Body composition for one reading, in display order and units. Masses convert
 * to lb like every other weight on this page; the fat ratio stays a percentage.
 * Keys the scale didn't report are skipped, so a partial sync renders what it
 * has instead of padding the row with blanks.
 */
const COMPOSITION_FIELDS: { key: string; label: string; unit: "lb" | "%" }[] = [
  { key: "fat_ratio_percent", label: "Fat", unit: "%" },
  { key: "fat_mass_kg", label: "Fat mass", unit: "lb" },
  { key: "muscle_mass_kg", label: "Muscle", unit: "lb" },
  { key: "hydration_kg", label: "Hydration", unit: "lb" },
  { key: "bone_mass_kg", label: "Bone", unit: "lb" },
  { key: "fat_free_mass_kg", label: "Fat-free", unit: "lb" },
];

function toComposition(
  bodyMetrics: Record<string, number> | null,
): { label: string; value: string }[] {
  if (!bodyMetrics) return [];
  return COMPOSITION_FIELDS.flatMap(({ key, label, unit }) => {
    const raw = bodyMetrics[key];
    if (raw == null) return [];
    const value = unit === "%" ? `${raw.toFixed(1)}%` : `${(raw * LB_PER_KG).toFixed(1)} lb`;
    return [{ label, value }];
  });
}

function toViewDays(pages: RouterOutputs["weight"]["days"][], now: Date, timeZone: string): WeightReadingDay[] {
  const all = pages.flatMap((page) =>
    page.days.map((d) => ({
      key: d.day,
      label: formatRecency(d.day, now, timeZone),
      medianLb: d.medianKg == null ? null : d.medianKg * LB_PER_KG,
      dayDeltaLb: d.dayDeltaKg == null ? null : d.dayDeltaKg * LB_PER_KG,
      readings: d.readings.map((r) => ({
        id: r.id,
        timeLabel: formatInTimeZone(r.measuredAt, timeZone, { hour: "numeric", minute: "2-digit" }),
        lb: r.weightKg * LB_PER_KG,
        deltaLb: r.deltaKg == null ? null : r.deltaKg * LB_PER_KG,
        excluded: r.excludedReason != null,
        auto: r.excludedReason === "sanity_band",
        composition: toComposition(r.bodyMetrics),
      })),
    })),
  );
  // A weigh-in landing on a new day shifts every page's cursor by one day, so
  // a day can appear at the tail of one page AND the head of the next once a
  // stale page refetches with its original (now-shifted) params. Keep the
  // first occurrence — pages are ordered newest-first, so that's the copy
  // with the most complete reading list.
  const seen = new Set<string>();
  return all.filter((d) => {
    if (seen.has(d.key)) return false;
    seen.add(d.key);
    return true;
  });
}

/**
 * A fat RATIO is already a percentage — the kg→lb factor the rest of this page
 * applies would turn 17.1% into a meaningless 37.7. Every other metric is a
 * mass and converts normally.
 */
function unitOf(metric: WeightMetricValue): WeightUnit {
  return metric === "fat_ratio_percent" ? "%" : "lb";
}

/** Scale factor from the api's kg/percent into the view's display unit. */
function factorOf(metric: WeightMetricValue): number {
  return unitOf(metric) === "%" ? 1 : LB_PER_KG;
}

function useWeightVariants(): { variants: DetailVariant[]; loading: boolean } {
  const [range, setRange] = useState<WeightRange>("30d");
  const [metric, setMetric] = useState<WeightMetricValue>("weight_kg");
  const now = useNow();
  const timeZone = useTimeZone();

  const utils = trpc.useUtils();
  useEffect(() => {
    void utils.weight.summary.invalidate();
    void utils.weight.days.invalidate();
  }, [timeZone, utils]);
  const summaryQuery = trpc.weight.summary.useQuery(
    { range, metric },
    { refetchInterval: POLL.weight, placeholderData: keepPreviousData },
  );

  // While switching metrics, keepPreviousData renders the OLD metric's summary
  // (avoiding the "blank chart" flash on the first switch to a metric) but the
  // live `metric` state already points at the NEW selection — deriving
  // unit/factor from `metric` while `summary` still holds old-metric numbers
  // would mislabel them (e.g. a raw kg value shown with a "%" suffix).
  // resolvedMetric tracks which metric `summary` actually belongs to, and only
  // advances once the new metric's real (non-placeholder) data has landed, so
  // the unit label and the numbers it describes always swap together.
  const [resolvedMetric, setResolvedMetric] = useState<WeightMetricValue>(metric);
  useEffect(() => {
    if (summaryQuery.isPlaceholderData) return;
    if (summaryQuery.data === undefined) return;
    setResolvedMetric(metric);
  }, [summaryQuery.data, summaryQuery.isPlaceholderData, metric]);
  const daysQuery = trpc.weight.days.useInfiniteQuery(
    {},
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      // No polling: pages are keyed by absolute day-string cursors, frozen at
      // first fetch. A poll refetches every page with those stale params,
      // which silently drops or duplicates a day whenever a weigh-in shifts
      // which day falls on a page boundary. The mutations below already
      // invalidate on their own, which is the only time this list can change.
    },
  );
  const invalidate = () => {
    void utils.weight.summary.invalidate();
    void utils.weight.days.invalidate();
  };
  const setExcludedMutation = trpc.weight.setExcluded.useMutation({ onSettled: invalidate });
  const deleteMutation = trpc.weight.delete.useMutation({ onSettled: invalidate });

  // The Readings list can't poll (its day-string cursors are frozen at first
  // fetch — a timed refetch would drop/dupe a boundary day). Instead, piggyback
  // on the summary poll: when its freshness token advances, a new reading has
  // landed, so invalidate the list once. The first observed value only seeds
  // the ref (the list's own initial fetch is already current).
  const lastSeenAt = useRef<string | null>(null);
  const latestMeasuredAt = summaryQuery.data?.latestMeasuredAt ?? null;
  useEffect(() => {
    if (latestMeasuredAt === null) return;
    if (lastSeenAt.current === null) {
      lastSeenAt.current = latestMeasuredAt;
      return;
    }
    if (lastSeenAt.current !== latestMeasuredAt) {
      lastSeenAt.current = latestMeasuredAt;
      void utils.weight.days.invalidate();
    }
  }, [latestMeasuredAt, utils]);

  const summary = summaryQuery.data;
  const pages = daysQuery.data?.pages;

  // Stable identity: the view observes this in an effect, so a function whose
  // identity changed every time isFetchingNextPage flipped (the old
  // dependency array) tore down and recreated the IntersectionObserver on
  // every fetch — and a fresh observer re-fires immediately for a sentinel
  // that's still on screen, chain-fetching every page back to back. Read the
  // latest query state from refs instead of closing over it.
  const hasNextPageRef = useRef(daysQuery.hasNextPage);
  hasNextPageRef.current = daysQuery.hasNextPage;
  const isFetchingNextPageRef = useRef(daysQuery.isFetchingNextPage);
  isFetchingNextPageRef.current = daysQuery.isFetchingNextPage;
  const fetchNextPageRef = useRef(daysQuery.fetchNextPage);
  fetchNextPageRef.current = daysQuery.fetchNextPage;
  const loadMore = useCallback(() => {
    if (hasNextPageRef.current && !isFetchingNextPageRef.current) void fetchNextPageRef.current();
  }, []);

  const variants: DetailVariant[] = [
    {
      slug: "trend",
      label: "Trend",
      render: () => {
        // Derived from resolvedMetric, not the live `metric` — while a switch
        // is in flight `summary` may still be the previous metric's data
        // (kept on screen via keepPreviousData to avoid a blank-chart flash),
        // and resolvedMetric is what actually pairs with those numbers.
        const f = factorOf(resolvedMetric);
        return summary ? (
          <WeightPageView
            status={TileStatus.Populated}
            range={range}
            onRangeChange={setRange}
            metric={metric}
            onMetricChange={setMetric}
            unit={unitOf(resolvedMetric)}
            lb={summary.latestKg * f}
            daily={summary.daily.map((d) => ({ day: d.day, lb: d.kg * f }))}
            low={summary.low * f}
            high={summary.high * f}
            average={summary.average * f}
            change={summary.change * f}
            windowLabel={windowLabelOf(summary.daily, now, timeZone) ?? undefined}
          />
        ) : (
          // Null summary = nothing to plot for this metric — either day one, or
          // a metric the scale has never reported. Not an error.
          <WeightPageView
            status={summaryQuery.isPending ? TileStatus.Loading : TileStatus.Populated}
            range={range}
            onRangeChange={setRange}
            metric={metric}
            onMetricChange={setMetric}
            unit={unitOf(resolvedMetric)}
          />
        );
      },
    },
    {
      slug: "readings",
      label: "Readings",
      render: () => (
        <WeightReadingsView
          status={pages ? TileStatus.Populated : TileStatus.Loading}
          days={pages ? toViewDays(pages, now, timeZone) : undefined}
          onToggle={(id, excluded) => setExcludedMutation.mutate({ id, excluded })}
          onDelete={(id) => deleteMutation.mutate({ id })}
          onLoadMore={daysQuery.hasNextPage ? loadMore : undefined}
        />
      ),
    },
  ];

  // Variants render their own skeletons; the page itself is never "loading",
  // so day one still shows the Trend/Readings switcher instead of a bare shim.
  return { variants, loading: false };
}

export const weightDetailEntry: TileDetailPageEntry = {
  kind: "page",
  tileId: "tile_weight",
  title: "Weight",
  defaultSlug: "trend",
  useVariants: useWeightVariants,
};
