import { Tile, TileHeader } from "@/components/ui";
import { useNow } from "@/lib/hooks";
import { trpc } from "@/lib/trpc";
import {
  courseWeek,
  dayAt,
  doses,
  LB_PER_KG,
  plannedInjections,
  type RecordSet,
  remaining,
  usedVolume,
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
  const c = data?.course,
    actual = data ? doses(data) : [],
    plan = c ? plannedInjections(c) : [],
    today = c ? dayAt(now, c.timezone) : "";
  const next = plan.find(
    (p) =>
      dayAt(p.at, c?.timezone ?? "UTC") >= today &&
      !actual.some((i) => i.plannedAt && Date.parse(i.plannedAt) === Date.parse(p.at)),
  );
  const vial = data?.vials.find((v) => !v.retired),
    last = actual.at(-1);
  return (
    <Tile padding={22}>
      <TileHeader icon="weight" title={c?.medication ?? "Injection tracker"} />
      {!data ? (
        <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
          <strong style={{ fontSize: 24 }}>Your course, together.</strong>
          <span style={{ color: "var(--ink-2)", fontSize: 16 }}>
            Plan · injections · weight · progress
          </span>
          <span style={{ color: "var(--acc)", fontSize: 16 }}>Open tracker</span>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12, marginTop: 12, fontSize: 16 }}>
          <span style={{ color: "var(--ink-2)" }}>
            Week {courseWeek(data.course, now)} · {data.course.status}
          </span>
          <strong style={{ fontSize: 24, color: "var(--acc)" }}>
            {next && dayAt(next.at, data.course.timezone) === today
              ? "Dose planned today"
              : next
                ? `Next · ${dateLabel(next.at, data.course.timezone)}`
                : "No upcoming plan"}
          </strong>
          <span>
            {next ? `${next.units} units · ${number(next.mg)} mg` : "Edit schedule in tracker"}
          </span>
          <span>
            Last ·{" "}
            {last
              ? `${dateLabel(last.at, data.course.timezone)} · ${last.units} units`
              : "not recorded"}
          </span>
          <span>
            Estimated remaining · {number(remaining(actual, now, data.course.halfLifeDays))} mg
          </span>
          <span>
            Vial ·{" "}
            {vial
              ? `${number((1 - usedVolume(vial, data.injections) / vial.volume) * 100, 0)}% remaining`
              : "not selected"}
          </span>
          <span>
            Weight ·{" "}
            {weight
              ? `${number(weight.kg * LB_PER_KG, 1)} lb · ${number(weight.change * LB_PER_KG, 1)} lb`
              : "no course reading"}
          </span>
          <small style={{ color: "var(--ink-2)" }}>
            {data.checkIns.some((e) => e.date === today)
              ? "Today's check-in logged"
              : "Check-in not logged today"}
          </small>
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
  const weight = trpc.weight.summary.useQuery(
    { range: "all", tz: course?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone },
    { enabled: !!course, refetchInterval: 60000 },
  );
  const now = useNow(),
    days = weight.data?.daily.filter((d) => course && d.day >= course.startDate),
    first = days?.[0],
    last = days?.at(-1);
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
      weight={first && last ? { kg: last.kg, change: last.kg - first.kg } : undefined}
    />
  );
}
