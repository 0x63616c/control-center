/**
 * Weight tile (Track C, Wave 2 fold): container + presentational view, merged
 * into one file per the tile-inlining convention (network.tsx precedent).
 * Spec: docs/superpowers/specs/2026-07-21-weight-tile-design.md.
 */
import { useEffect } from "react";
import { Icon } from "@/components/Icon";
import { Skeleton, Tile, TileHeader, TileStatus } from "@/components/ui";
import { POLL, useNow } from "@/lib/hooks";
import { formatDateKey, timeZoneDateKey, useTimeZone } from "@/lib/time-zone";
import { trpc } from "@/lib/trpc";
import { useTileQuery } from "@/lib/useTileQuery";

// Duplicated from the feature's own service on purpose: web must not import
// api runtime code across the feature/web boundary either — this constant is
// cheap enough to just restate (was already duplicated pre-fold, from
// apps/api's weight-domain).
export const LB_PER_KG = 2.2046226218;

export interface WeightTileViewProps {
  status: TileStatus;
  /** Latest included reading, in lb (converted once at the container boundary). */
  lb?: number;
  /** "Today" / "Yesterday" / "Jul 12" — see formatRecency. */
  recencyLabel?: string;
  /** 30d change in lb (latest daily median − earliest in window). Absent until 2+ days. */
  deltaLb30?: number;
  /** Daily lb values, oldest → newest, for the sparkline. */
  spark?: number[];
}

/** "Today" for the current local day, "Yesterday" for the previous, else "Jul 12".
 * Also consumed by detail/wiring/weight.tsx (apps/web) via @features/weight/web. */
export function formatRecency(dateKey: string, now: Date, timeZone: string): string {
  const today = timeZoneDateKey(now, timeZone);
  const diffDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dateKey}T00:00:00Z`)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return formatDateKey(dateKey, { month: "short", day: "numeric" });
}

// Map the series onto an SVG viewBox. Padding keeps the 2px stroke inside the
// box; y is inverted (SVG grows downward).
function linePoints(lbs: number[], w: number, h: number, pad = 6): { x: number; y: number }[] {
  const min = Math.min(...lbs);
  const max = Math.max(...lbs);
  const span = lbs.length > 1 ? lbs.length - 1 : 1;
  return lbs.map((lb, i) => ({
    x: pad + (i / span) * (w - 2 * pad),
    y: pad + ((max - lb) / (max - min || 1)) * (h - 2 * pad),
  }));
}

function pathFrom(pts: { x: number; y: number }[]): string {
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

function DeltaBadge({ deltaLb30 }: { deltaLb30: number }) {
  const down = deltaLb30 < 0;
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        fontSize: 12,
        fontWeight: 700,
        color: down ? "var(--acc)" : "var(--ink-2)",
      }}
    >
      <Icon name={down ? "down" : "up"} s={13} />
      {Math.abs(deltaLb30).toFixed(1)} lb / 30d
    </span>
  );
}

function WeightSkeleton() {
  return (
    <Tile padding={20}>
      <TileHeader icon="weight" title="Weight" />
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        <Skeleton w="100%" h={56} borderRadius={6} />
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <Skeleton w={110} h={40} borderRadius={6} />
          <div style={{ marginLeft: "auto" }}>
            <Skeleton w={44} h={12} borderRadius={4} />
          </div>
        </div>
      </div>
    </Tile>
  );
}

const SPARK_W = 260;
const SPARK_H = 56;

export function WeightTileView(props: WeightTileViewProps) {
  // Error shares the loading skeleton (no distinct face); "populated" with no
  // data yet (day one, nothing ingested) also renders the skeleton — no fake
  // numbers, ever.
  const { lb, recencyLabel, deltaLb30, spark } = props;
  if (props.status !== TileStatus.Populated || lb == null || spark == null) {
    return <WeightSkeleton />;
  }

  // One data point is not a trend: the path degenerates to a bare moveto, so the
  // line is invisible and the latest-point dot floats alone against an empty
  // box. Reserve the space (keeps the hero number pinned to the bottom) and
  // draw nothing until there are 2+ days — same rule as the delta badge.
  const hasTrend = spark.length >= 2;
  const pts = hasTrend ? linePoints(spark, SPARK_W, SPARK_H) : [];
  const last = pts[pts.length - 1];

  return (
    <Tile padding={20} style={{ position: "relative" }}>
      <TileHeader
        icon="weight"
        title="Weight"
        right={deltaLb30 != null ? <DeltaBadge deltaLb30={deltaLb30} /> : undefined}
      />
      {/* Sparkline on top, hero number + recency at the bottom */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        <div style={{ position: "relative", height: SPARK_H }} data-testid="weight-spark">
          {hasTrend && (
            <>
              <svg
                viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
                preserveAspectRatio="none"
                style={{ width: "100%", height: SPARK_H, display: "block" }}
                aria-hidden="true"
              >
                <path
                  d={pathFrom(pts)}
                  fill="none"
                  stroke="var(--acc)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
              </svg>
              {/* Latest-point dot drawn outside the stretched svg so it stays round */}
              {last && (
                <span
                  data-testid="weight-spark-dot"
                  style={{
                    position: "absolute",
                    right: 4,
                    bottom: SPARK_H - last.y - 4,
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    background: "var(--acc)",
                  }}
                />
              )}
            </>
          )}
        </div>
        {/* lineHeight 1 — the 40px mono's default leading otherwise pads the
            bottom edge unevenly vs the 20px tile padding at the top */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, lineHeight: 1 }}>
          <span
            className="mono"
            style={{ fontSize: 40, fontWeight: 700, letterSpacing: "-0.02em" }}
          >
            {lb.toFixed(1)}
          </span>
          <span style={{ fontSize: 14, color: "var(--ink-2)" }}>lb</span>
          <span
            className="mono"
            style={{ fontSize: 12, color: "var(--ink-2)", marginLeft: "auto" }}
          >
            {recencyLabel}
          </span>
        </div>
      </div>
    </Tile>
  );
}

/**
 * WeightTile — container for the Weight tile. Polls weight.summary (30d
 * window) every 60s and maps it onto WeightTileView. kg→lb conversion
 * happens once here; the view and everything below it speak lb only.
 */
export function WeightTile() {
  const timeZone = useTimeZone();
  const utils = trpc.useUtils();
  useEffect(() => {
    void utils.weight.summary.invalidate();
  }, [timeZone, utils]);
  const tile = useTileQuery(trpc.weight.summary.useQuery({ range: "30d" }, { refetchInterval: POLL.weight }));
  const now = useNow();

  // Loading covers error-with-nothing-cached AND the day-one null summary
  // (no included readings yet): skeleton, never invented data.
  if (tile.status !== TileStatus.Populated) {
    return <WeightTileView status={tile.status} />;
  }

  const data = tile.data;
  return (
    <WeightTileView
      status={TileStatus.Populated}
      lb={data.latestKg * LB_PER_KG}
      // day is a zone-independent YYYY-MM-DD key.
      recencyLabel={formatRecency(data.latestDay, now, timeZone)}
      // A 1-day window has no change to speak of; hide the badge until 2+ days.
      deltaLb30={data.daily.length >= 2 ? data.change * LB_PER_KG : undefined}
      spark={data.daily.map((d) => d.kg * LB_PER_KG)}
    />
  );
}
