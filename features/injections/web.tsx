import { Tile, TileHeader } from "@/components/ui";
import { useNow } from "@/lib/hooks";
import { trpc } from "@/lib/trpc";
import {
  addDays,
  dayAt,
  doses,
  LB_PER_KG,
  projectedDoses,
  type RecordSet,
  remaining,
  weightStats,
  zonedTime,
} from "./model";
import { dateLabel, number } from "./web/Timeline";

export function InjectionTileView({
  data,
  now = Date.now(),
  weight,
}: {
  data?: RecordSet;
  now?: number;
  weight?: { kg: number; change: number };
}) {
  const c = data?.course;
  const actual = data ? doses(data) : [];
  const next = data ? projectedDoses(data, now).future[0] : undefined;
  const last = actual.at(-1);
  return (
    <Tile padding={22}>
      <TileHeader icon="weight" title={c?.medication ?? "Injection tracker"} />
      {!data ? (
        <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
          <strong style={{ fontSize: 24 }}>Log your first dose</strong>
          <span style={{ color: "var(--ink-2)", fontSize: 16 }}>
            Estimated amount · weight progress
          </span>
          <span style={{ color: "var(--acc)", fontSize: 16 }}>Tap to log a dose</span>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12, marginTop: 12, fontSize: 16 }}>
          <span style={{ color: "var(--ink-2)" }}>Estimated in your body</span>
          <strong style={{ fontSize: 36, color: "var(--acc)" }}>
            {actual.length ? number(remaining(actual, now, data.course.halfLifeDays)) : "—"} mg
          </strong>
          <span>
            Last ·{" "}
            {last
              ? `${dateLabel(last.at, data.course.timezone)} · ${last.units} units`
              : "not recorded"}
          </span>
          <span>
            Next planned ·{" "}
            {next ? `${next.units} units · ${dateLabel(next.at, data.course.timezone)}` : "none"}
          </span>
          <span>
            Weight ·{" "}
            {weight
              ? `${number(weight.kg * LB_PER_KG, 1)} lb · ${number(weight.change * LB_PER_KG, 1)} lb`
              : "no course reading"}
          </span>
          <small style={{ color: "var(--acc)" }}>Tap to log a dose</small>
        </div>
      )}
    </Tile>
  );
}
export function InjectionTile() {
  const courses = trpc.injections.list.useQuery(undefined, { refetchInterval: 60000 });
  const course = [...(courses.data?.courses ?? [])].reverse().find((c) => c.status === "active");
  const detail = trpc.injections.detail.useQuery(
    { courseId: course?.id ?? "icr_none" },
    { enabled: !!course, refetchInterval: 60000 },
  );
  const timezone = course?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const weight = trpc.weight.timeline.useQuery(
    {
      from: new Date(
        zonedTime(course?.startDate ?? dayAt(Date.now(), timezone), "00:00", timezone),
      ).toISOString(),
      to: new Date(
        zonedTime(addDays(dayAt(Date.now(), timezone), 1), "00:00", timezone),
      ).toISOString(),
    },
    {
      enabled: !!course && course.startDate <= dayAt(Date.now(), timezone),
      refetchInterval: 60000,
    },
  );
  const now = useNow(),
    stats = course ? weightStats(weight.data ?? [], course, now.getTime()) : null;
  if (courses.error || detail.error)
    return (
      <Tile padding={22}>
        <TileHeader icon="weight" title="Injection tracker" />
        <p>Tracker unavailable. Open to retry.</p>
      </Tile>
    );
  return (
    <InjectionTileView
      data={detail.data}
      now={now.getTime()}
      weight={stats ? { kg: stats.last.kg, change: stats.change } : undefined}
    />
  );
}
