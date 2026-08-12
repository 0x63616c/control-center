import { Segmented, Skeleton, Stat, TileStatus } from "@/components/ui";

/**
 * WeightPageView — presentational Trend page body for the weight detail page
 * (spec 2026-07-21-weight-tile-design). Hosted by TileDetailHost (which owns
 * the PageHeader/back button): first row = full-width metric picker (weight
 * plus the Withings body-composition series), second = centered 7d/30d/All
 * range picker with the current value on the right, chart flex-fills the
 * middle, and the Low/High/Average/Change stat row pins to the bottom. Ported
 * from the approved WeightConceptDetail concept.
 *
 * Both pickers stay mounted in every state — see the `hasData` comment below.
 * All numbers arrive pre-converted in `unit`; this component never does math
 * on them beyond formatting.
 */

export type WeightRange = "7d" | "30d" | "all";

/** Mirrors WEIGHT_METRICS in features/weight/service. */
export type WeightMetricValue =
  | "weight_kg"
  | "fat_ratio_percent"
  | "fat_mass_kg"
  | "muscle_mass_kg"
  | "hydration_kg"
  | "bone_mass_kg"
  | "fat_free_mass_kg";

/**
 * Display unit of the selected metric. The wiring layer has already converted
 * kg→lb where that applies; a percentage is passed through untouched, because
 * a fat ratio has no lb equivalent.
 */
export type WeightUnit = "lb" | "%";

export interface WeightPageViewProps {
  status: TileStatus;
  range: WeightRange;
  onRangeChange: (range: WeightRange) => void;
  metric: WeightMetricValue;
  onMetricChange: (metric: WeightMetricValue) => void;
  /** Unit of every number below — drives formatting only. */
  unit?: WeightUnit;
  /** Latest included reading, in `unit`. */
  lb?: number;
  /** Daily medians for the window, in `unit`, oldest → newest. */
  daily?: { day: string; lb: number }[];
  low?: number;
  high?: number;
  average?: number;
  change?: number;
  /** e.g. "Jun 22 – Today". */
  windowLabel?: string;
}

const RANGE_OPTIONS = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All time" },
];

const METRIC_OPTIONS: { value: WeightMetricValue; label: string }[] = [
  { value: "weight_kg", label: "Weight" },
  { value: "fat_ratio_percent", label: "Fat %" },
  { value: "fat_mass_kg", label: "Fat mass" },
  { value: "muscle_mass_kg", label: "Muscle" },
  { value: "hydration_kg", label: "Hydration" },
  { value: "bone_mass_kg", label: "Bone" },
  { value: "fat_free_mass_kg", label: "Fat-free" },
];

/** "182.4 lb" / "17.1%" — percent hugs its number, lb takes a space. */
function fmt(value: number, unit: WeightUnit): string {
  return unit === "%" ? `${value.toFixed(1)}%` : `${value.toFixed(1)} lb`;
}

// Chart viewBox; stretched to the flexed box with preserveAspectRatio none.
const W = 1120;
const H = 380;
const PAD = 16;
const DAY_MS = 24 * 60 * 60 * 1000;

interface ChartPoint {
  readonly day: string;
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

interface ChartSegment {
  readonly id: string;
  readonly kind: "solid" | "gap";
  readonly path: string;
}

function dayTime(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/** Position by real elapsed days, not array index — a skipped weigh-in has to
 *  read as a gap, or the line misstates how fast the weight moved. */
function linePoints(daily: { day: string; lb: number }[]): ChartPoint[] {
  const lbs = daily.map((d) => d.lb);
  const min = Math.min(...lbs);
  const max = Math.max(...lbs);
  const t = daily.map((d) => dayTime(d.day));
  const t0 = t[0] ?? 0;
  const span = (t[t.length - 1] ?? t0) - t0 || 1;
  return daily.map((d, i) => ({
    day: d.day,
    time: t[i] ?? t0,
    x: PAD + (((t[i] ?? t0) - t0) / span) * (W - 2 * PAD),
    y: PAD + ((max - d.lb) / (max - min || 1)) * (H - 2 * PAD),
  }));
}

/** Catmull-Rom controls keep joins smooth while separate SVG paths let each
 * interval communicate whether the intervening calendar days have data. */
function chartSegments(pts: readonly ChartPoint[]): ChartSegment[] {
  return pts.slice(0, -1).flatMap((start, index) => {
    const end = pts[index + 1];
    if (!end) return [];
    const before = pts[index - 1] ?? start;
    const after = pts[index + 2] ?? end;
    const c1x = start.x + (end.x - before.x) / 6;
    const c1y = start.y + (end.y - before.y) / 6;
    const c2x = end.x - (after.x - start.x) / 6;
    const c2y = end.y - (after.y - start.y) / 6;
    return [
      {
        id: `${start.day}-${end.day}`,
        kind: end.time - start.time > DAY_MS ? "gap" : "solid",
        path: `M${start.x.toFixed(1)},${start.y.toFixed(1)} C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}`,
      },
    ];
  });
}

function dateTicks(pts: readonly ChartPoint[], maximum = 5): ChartPoint[] {
  const count = Math.min(maximum, pts.length);
  if (count === 0) return [];
  const indexes = Array.from({ length: count }, (_, i) =>
    Math.round((i * (pts.length - 1)) / Math.max(count - 1, 1)),
  );
  return indexes.flatMap((index, i) => {
    const point = pts[index];
    return point && indexes.indexOf(index) === i ? [point] : [];
  });
}

function formatDay(day: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(dayTime(day));
}

/** Chart + stats placeholder. The pickers are NOT part of this: they stay
 *  mounted and interactive in every state (see WeightPageView). */
function BodySkeleton() {
  return (
    <>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Skeleton w="100%" h="100%" borderRadius={12} />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 16,
          marginTop: 8,
          flexShrink: 0,
        }}
      >
        <Skeleton w="100%" h={64} borderRadius={10} />
        <Skeleton w="100%" h={64} borderRadius={10} />
        <Skeleton w="100%" h={64} borderRadius={10} />
        <Skeleton w="100%" h={64} borderRadius={10} />
      </div>
    </>
  );
}

/** Populated, but this metric has nothing to plot — the scale never reported
 *  it, or it predates the Withings integration. Says which metric, so it does
 *  not read as the whole page being broken. */
function NoMetricData({ metric }: { metric: WeightMetricValue }) {
  const label = METRIC_OPTIONS.find((o) => o.value === metric)?.label ?? "This metric";
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
      }}
    >
      <span style={{ fontSize: 15, color: "var(--ink-2)" }}>No {label.toLowerCase()} data yet</span>
      <span style={{ fontSize: 13, color: "var(--ink-3)" }}>
        It appears here once the scale reports it.
      </span>
    </div>
  );
}

export function WeightPageView(props: WeightPageViewProps) {
  const {
    status,
    range,
    onRangeChange,
    metric,
    onMetricChange,
    unit = "lb",
    lb,
    daily,
    low,
    high,
    average,
    change,
    windowLabel,
  } = props;
  // The pickers must survive every state: if selecting a metric with no data
  // swapped the whole page for a skeleton, the control you'd use to switch
  // back would go with it. Only the chart + stats below react to `hasData`.
  const hasData =
    status === TileStatus.Populated &&
    lb != null &&
    daily != null &&
    daily.length > 0 &&
    low != null &&
    high != null &&
    average != null &&
    change != null;

  const lbs = daily?.map((d) => d.lb) ?? [];
  // Below two daily points there is no line to draw: one dot on an axis whose
  // min and max labels are identical reads as a broken chart, not as "no data
  // yet". Matches what 3e68f7ff6 did for the tile sparkline.
  const enoughForChart = hasData && daily != null && daily.length >= 2;
  const pts = enoughForChart && daily != null ? linePoints(daily) : [];
  const segments = chartSegments(pts);
  const ticks = dateTicks(pts);
  const dailyMin = lbs.length ? Math.min(...lbs) : 0;
  const dailyMax = lbs.length ? Math.max(...lbs) : 0;
  const iMin = lbs.indexOf(dailyMin);
  const iMax = lbs.indexOf(dailyMax);
  const gridMin = pts[iMin];
  const gridMax = pts[iMax];

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 24,
        padding: "0 72px",
      }}
    >
      {/* Which series is plotted. Full width above the range row — seven
          options do not fit alongside the range picker at 1366. */}
      <Segmented label="Metric" options={METRIC_OPTIONS} value={metric} onChange={onMetricChange} />
      {/* Range picker centered; current value on the right (host owns the
          header, so the hero number lives in the body's first row). */}
      <div style={{ position: "relative", display: "flex", justifyContent: "center" }}>
        <div style={{ width: 360 }}>
          <Segmented
            label="Range"
            options={RANGE_OPTIONS}
            value={range}
            onChange={(v) => onRangeChange(v as WeightRange)}
          />
        </div>
        {hasData && lb != null && (
          <span
            className="mono"
            style={{
              position: "absolute",
              right: 0,
              top: "50%",
              transform: "translateY(-50%)",
              fontSize: 34,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              lineHeight: 1,
            }}
          >
            {/* "%" belongs to the number and stays at full size; "lb" is a
                unit word and rides small and dimmed beside it. */}
            {unit === "%" ? (
              `${lb.toFixed(1)}%`
            ) : (
              <>
                {lb.toFixed(1)}
                <span style={{ fontSize: 15, fontWeight: 400, color: "var(--ink-2)" }}> lb</span>
              </>
            )}
          </span>
        )}
      </div>
      {!hasData ? (
        // Still fetching vs genuinely empty for this metric — a skeleton that
        // never resolves would otherwise imply the data is on its way.
        status !== TileStatus.Populated ? (
          <BodySkeleton />
        ) : (
          <NoMetricData metric={metric} />
        )
      ) : (
        <>
          {/* Chart fills the space between picker and stats */}
          <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
            {enoughForChart ? (
              <>
                <svg
                  viewBox={`0 0 ${W} ${H}`}
                  preserveAspectRatio="none"
                  style={{ width: "100%", height: "100%", display: "block" }}
                  aria-hidden="true"
                >
                  {gridMax && (
                    <line
                      x1={PAD}
                      x2={W - PAD}
                      y1={gridMax.y}
                      y2={gridMax.y}
                      stroke="rgba(255,255,255,0.08)"
                      strokeWidth={1}
                    />
                  )}
                  {gridMin && (
                    <line
                      x1={PAD}
                      x2={W - PAD}
                      y1={gridMin.y}
                      y2={gridMin.y}
                      stroke="rgba(255,255,255,0.08)"
                      strokeWidth={1}
                    />
                  )}
                  {segments.map((segment) => (
                    <path
                      key={segment.id}
                      data-testid={`weight-trend-${segment.kind}`}
                      d={segment.path}
                      fill="none"
                      stroke="var(--acc)"
                      strokeWidth={2}
                      strokeDasharray={segment.kind === "gap" ? "2 7" : undefined}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ))}
                </svg>
                {/* HTML markers stay round even though the SVG stretches to the chart box. */}
                {pts.map((point) => (
                  <span
                    key={point.day}
                    data-testid="weight-trend-point"
                    style={{
                      position: "absolute",
                      left: `${(point.x / W) * 100}%`,
                      top: `${(point.y / H) * 100}%`,
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: "var(--acc)",
                      transform: "translate(-50%, -50%)",
                    }}
                  />
                ))}
                {/* Axis labels describe the DAILY series, which is what the line
                plots. low/high are raw-reading figures and no longer sit on it. */}
                {gridMax && (
                  <span
                    className="mono"
                    style={{
                      position: "absolute",
                      left: 0,
                      top: `calc(${(gridMax.y / H) * 100}% - 20px)`,
                      fontSize: 12,
                      color: "var(--ink-2)",
                    }}
                  >
                    {dailyMax.toFixed(1)}
                  </span>
                )}
                {gridMin && (
                  <span
                    className="mono"
                    style={{
                      position: "absolute",
                      left: 0,
                      top: `calc(${(gridMin.y / H) * 100}% + 8px)`,
                      fontSize: 12,
                      color: "var(--ink-2)",
                    }}
                  >
                    {dailyMin.toFixed(1)}
                  </span>
                )}
                {ticks.map((point, index) => (
                  <span
                    key={point.day}
                    className="mono"
                    style={{
                      position: "absolute",
                      left: `${(point.x / W) * 100}%`,
                      bottom: -18,
                      transform:
                        index === 0
                          ? "translateX(0)"
                          : index === ticks.length - 1
                            ? "translateX(-100%)"
                            : "translateX(-50%)",
                      fontSize: 12,
                      color: "var(--ink-2)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatDay(point.day)}
                  </span>
                ))}
              </>
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <span style={{ fontSize: 15, color: "var(--ink-2)" }}>Not enough data yet</span>
                <span style={{ fontSize: 13, color: "var(--ink-3)" }}>
                  The trend starts once you have weighed in on a second day.
                </span>
              </div>
            )}
            {windowLabel && !enoughForChart && (
              <span
                className="mono"
                style={{
                  position: "absolute",
                  right: 0,
                  bottom: -18,
                  fontSize: 12,
                  color: "var(--ink-2)",
                }}
              >
                {windowLabel}
              </span>
            )}
          </div>
          {/* Stats for the selected window — pinned under the chart */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 16,
              marginTop: 8,
              flexShrink: 0,
            }}
          >
            <Stat label="Low" value={fmt(low ?? 0, unit)} />
            <Stat label="High" value={fmt(high ?? 0, unit)} />
            <Stat label="Average" value={fmt(average ?? 0, unit)} />
            <Stat
              label="Change"
              value={`${(change ?? 0) > 0 ? "+" : ""}${fmt(change ?? 0, unit)}`}
              accent
            />
          </div>
        </>
      )}
    </div>
  );
}
