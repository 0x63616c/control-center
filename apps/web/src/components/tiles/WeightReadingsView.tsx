import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { ConfirmDialog, OverflowMenu, Pill, PillTone, Skeleton, TileStatus } from "@/components/ui";

/**
 * WeightReadingsView — presentational Readings variant of the weight detail
 * page (spec 2026-07-21-weight-tile-design).
 *
 * The day is the unit, not the individual weigh-in: the trend line plots one
 * point per day and that point is the day's median. So the list is one row per
 * recorded day — its median and its change against the previous day's median —
 * and a day expands to reveal the raw readings behind that median. Days are
 * collapsed by default, because the readings are evidence you go looking for,
 * not the headline.
 *
 * Down is green and up is amber throughout, on the weight-loss reading of the
 * data; that colour rule is the only place this component editorialises.
 *
 * Grouping and labelling happen upstream in the wiring layer, which owns the
 * timezone; this component renders whatever days it is handed, in order.
 */

export interface WeightReadingRow {
  id: string;
  /** Time-of-day only, e.g. "11:43 AM" — the day row carries the date. */
  timeLabel: string;
  lb: number;
  /** vs the previous included reading; null for excluded rows and the oldest. */
  deltaLb: number | null;
  excluded: boolean;
  /** True when the exclusion came from the sanity band, not a manual toggle. */
  auto: boolean;
  /**
   * Body composition for this reading, already formatted and unit-suffixed by
   * the wiring layer. Empty/absent for the retired ha_ble-era rows, which
   * carried a weight and nothing else — those simply render no strip rather
   * than a row of dashes.
   */
  composition?: { label: string; value: string }[];
}

export interface WeightReadingDay {
  /** Stable local calendar day, e.g. "2026-07-22". */
  key: string;
  /** "Today", "Yesterday", or "Mon Jul 20". */
  label: string;
  /** Median of the day's included readings — the value the trend line plots.
   *  Null when every reading that day was excluded (nothing left to count). */
  medianLb: number | null;
  /** vs the previous day's median; null when no earlier day is in range. */
  dayDeltaLb: number | null;
  /** Newest first. */
  readings: WeightReadingRow[];
}

export interface WeightReadingsViewProps {
  status: TileStatus;
  /** Newest day first. */
  days?: WeightReadingDay[];
  onToggle: (id: string, excluded: boolean) => void;
  /** Omitted until the tombstone column exists — the menu then hides Delete
   *  rather than offering an action that silently does nothing. */
  onDelete?: (id: string) => void;
  /** Called when the end of the list scrolls into view. Omit when there is
   *  nothing more to load — the sentinel is then not rendered at all. */
  onLoadMore?: () => void;
}

const MAX_W = 720;
const COL_WHEN = 96;
const COL_WEIGHT = 104;
const COL_DELTA = 56;

function ListSkeleton() {
  return (
    <div
      style={{
        maxWidth: MAX_W,
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <Skeleton w="100%" h={56} borderRadius={10} />
      <Skeleton w="100%" h={56} borderRadius={10} />
      <Skeleton w="100%" h={56} borderRadius={10} />
      <Skeleton w="100%" h={56} borderRadius={10} />
    </div>
  );
}

function signed(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(1)}`;
}

/** Down is good, up is bad — green and amber respectively. */
function deltaColor(n: number): string {
  if (n < 0) return "var(--green)";
  // Amber, not red: --red is the error/failure colour, and a 0.2 lb overnight
  // wobble is a nudge, not a failure.
  if (n > 0) return "var(--amber)";
  return "var(--ink-2)";
}

/** A weight and its unit, centred as one block so it lines up with plain text
 *  in neighbouring columns rather than sitting low on its own baseline. Null
 *  renders as an em dash — a day with no counted reading has no weight to
 *  show, and 0.0 would misreport it as an actual measurement. */
function Weight({
  lb,
  size,
  struck,
  width,
}: {
  lb: number | null;
  size: number;
  struck?: boolean;
  width: number;
}) {
  return (
    <span
      className="mono"
      style={{
        width,
        display: "flex",
        alignItems: "baseline",
        gap: 4,
        fontSize: size,
        fontWeight: 700,
        textDecoration: struck ? "line-through" : "none",
        color: lb == null ? "var(--ink-3)" : undefined,
      }}
    >
      {lb == null ? "—" : lb.toFixed(1)}
      {lb != null && (
        <span style={{ fontSize: 11, fontWeight: 400, color: "var(--ink-2)" }}>lb</span>
      )}
    </span>
  );
}

function Delta({ lb, strong }: { lb: number | null; strong?: boolean }) {
  return (
    <span
      className="mono"
      style={{
        width: COL_DELTA,
        fontSize: 13,
        fontWeight: strong ? 700 : 400,
        color: lb == null ? "var(--ink-3)" : deltaColor(lb),
      }}
    >
      {lb == null ? "" : signed(lb)}
    </span>
  );
}

/** The shared chevron glyph, rotated down when its day is open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <span
      style={{
        display: "grid",
        placeItems: "center",
        transform: open ? "rotate(90deg)" : "none",
        transition: "transform 0.15s ease",
      }}
    >
      <Icon name="chevron" s={16} c="var(--ink-3)" />
    </span>
  );
}

function ReadingRow({
  row,
  onToggle,
  onRequestDelete,
}: {
  row: WeightReadingRow;
  onToggle: (id: string, excluded: boolean) => void;
  onRequestDelete: ((row: WeightReadingRow) => void) | undefined;
}) {
  const composition = row.composition ?? [];
  return (
    <div style={{ opacity: row.excluded ? 0.55 : 1 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          // Indented under the day row it belongs to.
          padding: "8px 8px 8px 54px",
        }}
      >
        <span className="mono" style={{ width: COL_WHEN, fontSize: 13, color: "var(--ink-2)" }}>
          {row.timeLabel}
        </span>
        <Weight lb={row.lb} size={15} struck={row.excluded} width={COL_WEIGHT} />
        <Delta lb={row.deltaLb} />
        {row.excluded && row.auto && <Pill tone={PillTone.Amber}>AUTO-FLAGGED</Pill>}
        <span style={{ marginLeft: "auto" }} />
        <OverflowMenu
          label={`Actions for the ${row.timeLabel} reading`}
          items={[
            // Only an auto-flagged reading offers to be counted again — every
            // other row's exclusion would be a manual one nobody asked for.
            ...(row.excluded
              ? [
                  {
                    key: "include",
                    label: "Count this reading",
                    onSelect: () => onToggle(row.id, false),
                  },
                ]
              : []),
            ...(onRequestDelete
              ? [
                  {
                    key: "delete",
                    label: "Delete",
                    tone: "danger" as const,
                    onSelect: () => onRequestDelete(row),
                  },
                ]
              : []),
          ]}
        />
      </div>
      {/* Body composition, aligned under the weight column. Absent entirely
          for readings that never carried it. */}
      {composition.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "4px 18px",
            padding: "0 8px 10px 54px",
          }}
        >
          {composition.map((c) => (
            <span key={c.label} style={{ fontSize: 12, color: "var(--ink-3)" }}>
              {c.label}{" "}
              <span className="mono" style={{ color: "var(--ink-2)" }}>
                {c.value}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function DayGroup({
  day,
  onToggle,
  onRequestDelete,
}: {
  day: WeightReadingDay;
  onToggle: (id: string, excluded: boolean) => void;
  onRequestDelete: ((row: WeightReadingRow) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const count = day.readings.length;

  return (
    <div style={{ borderBottom: "1px solid var(--hair)" }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          width: "100%",
          padding: "13px 8px",
          background: "transparent",
          border: "none",
          color: "var(--ink)",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span style={{ width: 32, display: "grid", placeItems: "center", color: "var(--ink-3)" }}>
          <Chevron open={open} />
        </span>
        <span className="cap" style={{ width: COL_WHEN }}>
          {day.label}
        </span>
        <Weight lb={day.medianLb} size={19} width={COL_WEIGHT} />
        <Delta lb={day.dayDeltaLb} strong />
        <span style={{ marginLeft: "auto" }} />
        <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
          ({count})
        </span>
      </button>
      {open && (
        <div style={{ paddingBottom: 6 }}>
          {day.readings.map((row) => (
            <ReadingRow
              key={row.id}
              row={row}
              onToggle={onToggle}
              onRequestDelete={onRequestDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function WeightReadingsView({
  status,
  days,
  onToggle,
  onDelete,
  onLoadMore,
}: WeightReadingsViewProps) {
  const [pendingDelete, setPendingDelete] = useState<WeightReadingRow | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !onLoadMore) return;
    // root: the scrolling container itself, not the viewport — the panel is
    // a fixed 1366x1024 surface and this view can sit inside a shorter
    // wrapper, where a null root (viewport) would call the sentinel visible
    // even while its actual scroll ancestor has it scrolled out of view.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore();
      },
      { root: scrollRef.current, rootMargin: "48px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [onLoadMore]);

  if (status !== TileStatus.Populated || days == null) return <ListSkeleton />;

  if (days.length === 0) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ fontSize: 14, color: "var(--ink-3)" }}>
          No weigh-ins yet — step on the scale.
        </span>
      </div>
    );
  }

  return (
    // The page shell owns the scroll: fill the height, never grow past it.
    <div ref={scrollRef} style={{ height: "100%", overflowY: "auto" }}>
      <div style={{ maxWidth: MAX_W, margin: "0 auto" }}>
        {days.map((day) => (
          <DayGroup
            key={day.key}
            day={day}
            onToggle={onToggle}
            onRequestDelete={onDelete ? setPendingDelete : undefined}
          />
        ))}
        {onLoadMore && <div ref={sentinelRef} style={{ height: 1 }} aria-hidden="true" />}
      </div>
      <ConfirmDialog
        open={pendingDelete != null}
        tone="danger"
        title="Delete this reading?"
        message={
          pendingDelete && (
            <>
              The {pendingDelete.timeLabel} reading of {pendingDelete.lb.toFixed(1)} lb will be
              removed for good. Your other weigh-ins are untouched.
            </>
          )
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (pendingDelete) onDelete?.(pendingDelete.id);
          setPendingDelete(null);
        }}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}
