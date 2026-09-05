import { useState } from "react";
import type { TileDetailPageEntry } from "@/components/tiles/detail/types";
import { Button } from "@/components/ui/Button";
import { useNow } from "@/lib/hooks";
import { trpc } from "@/lib/trpc";
import {
  addDays,
  type Course,
  courseWeek,
  DAY,
  dayAt,
  doses,
  LB_PER_KG,
  plannedInjections,
  RANGES,
  type RecordSet,
  remaining,
  type Settings,
  scenario,
  UNITS,
  usedVolume,
  type Weight,
  weightStats,
  zonedTime,
} from "./model";
import { CheckInForm, CourseForm, ErrorMessage, InjectionForm, VialForm } from "./web/Forms";
import { Photos } from "./web/Photos";
import {
  Calendar,
  dateLabel,
  Inspector,
  number,
  ScenarioComparison,
  Timeline,
} from "./web/Timeline";
import "./web/styles.css";

type Screen =
  | { kind: "timeline" }
  | { kind: "course" }
  | { kind: "injection"; id?: string }
  | { kind: "vial"; id?: string }
  | { kind: "checkin"; date?: string };
export function TrackerView({
  data,
  weights,
  now,
  onAction,
  onSelected,
}: {
  data: RecordSet;
  weights: Weight[];
  now: number;
  onSelected?: (at: number) => void;
  onAction: (screen: Screen) => void;
}) {
  const c = data.course;
  const [selected, setSelected] = useState(
    c.status === "scenario" ? zonedTime(addDays(c.startDate, 28), "12:00", c.timezone) : now,
  );
  const select = (at: number) => {
    setSelected(at);
    onSelected?.(at);
  };
  const [range, setRange] = useState<Settings["range"]>(c.range),
    [unit, setUnit] = useState<Settings["primaryUnit"]>(c.primaryUnit),
    [mode, setMode] = useState("timeline");
  const actual = doses(data),
    plan = plannedInjections(c),
    today = dayAt(now, c.timezone);
  const next = plan.find(
    (p) =>
      dayAt(p.at, c.timezone) >= today &&
      !actual.some((i) => i.plannedAt && Date.parse(i.plannedAt) === Date.parse(p.at)),
  );
  const last = actual.filter((i) => Date.parse(i.at) <= now).at(-1),
    vial = data.vials.find((v) => !v.retired) ?? data.vials.at(-1),
    stats = c.status === "scenario" ? null : weightStats(weights, c, now);
  const week = courseWeek(c, now),
    actualWeek = actual.filter((i) => courseWeek(c, Date.parse(i.at)) === week),
    plannedWeek = plan.filter((i) => i.week === week);
  const estimated = remaining(actual, now, c.halfLifeDays),
    used = vial ? usedVolume(vial, data.injections, now) : 0;
  return (
    <>
      <div className="ij-row">
        <div>
          <span className="ij-eyebrow">
            {c.status === "scenario"
              ? "SCENARIO · PLANNED EVENTS ONLY"
              : `${c.status.toUpperCase()} COURSE · WEEK ${week} OF ${Math.max(...c.stages.map((s) => s.endWeek))}`}
          </span>
          <h1 style={{ marginTop: 8 }}>{c.name}</h1>
          <span className="ij-muted">
            {c.medication} · {c.concentration} mg/mL · {c.syringeScale} units/mL · {c.timezone}
            {c.status !== "scenario"
              ? ` · ${Math.max(0, Math.floor((now - zonedTime(c.startDate, "00:00", c.timezone)) / DAY))} days since start`
              : ""}
          </span>
        </div>
        <div className="ij-actions">
          <Button variant="ghost" onClick={() => onAction({ kind: "course" })}>
            Course settings
          </Button>
          {c.status !== "scenario" && (
            <Button onClick={() => onAction({ kind: "injection" })}>Log injection</Button>
          )}
        </div>
      </div>
      <div className="ij-stats">
        <Stat
          label={
            next && dayAt(next.at, c.timezone) === today ? "DOSE PLANNED TODAY" : "NEXT PLANNED"
          }
          value={next ? `${number(next.units)} units` : "No upcoming plan"}
          detail={
            next
              ? `${dateLabel(next.at, c.timezone)} · ${number(next.mg)} mg`
              : "Edit your schedule"
          }
        />
        <Stat
          label="ESTIMATED REMAINING"
          value={c.status === "scenario" ? "Scenario" : `${number(estimated)} mg`}
          detail={
            last
              ? `Last: ${dateLabel(last.at, c.timezone)} · ${last.units} units`
              : "No actual injections recorded"
          }
        />
        <Stat
          label="CURRENT VIAL"
          value={vial ? `${number((1 - used / vial.volume) * 100, 0)}%` : "No vial"}
          detail={
            vial
              ? `${number(vial.volume - used)} mL · ${number((vial.volume - used) * vial.concentration)} mg left`
              : "Add a vial"
          }
        />
        <Stat
          label="LATEST COURSE WEIGHT"
          value={stats ? `${number(stats.last.kg * LB_PER_KG, 1)} lb` : "No reading"}
          detail={
            stats
              ? `${number(stats.change * LB_PER_KG, 1)} lb · ${number(stats.percent, 1)}% since first reading`
              : "Uses your existing weight history"
          }
        />
      </div>
      {c.status !== "scenario" && (
        <div className="ij-row ij-muted">
          <span>
            This week · planned {number(plannedWeek.reduce((s, i) => s + i.mg, 0))} mg · actual{" "}
            {number(actualWeek.reduce((s, i) => s + i.mg, 0))} mg
          </span>
          <span>
            {data.checkIns.some((e) => e.date === today)
              ? "Today's check-in logged"
              : "Today's check-in not logged"}
          </span>
          <Button
            variant="ghost"
            onClick={() => {
              setSelected(now);
              onAction({ kind: "checkin" });
            }}
          >
            Check in today
          </Button>
        </div>
      )}
      <div className="ij-row">
        <div className="ij-actions">
          {["timeline", "calendar"].map((m) => (
            <button
              type="button"
              className="ij-pill"
              aria-pressed={mode === m}
              key={m}
              onClick={() => setMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="ij-actions">
          {RANGES.map((r) => (
            <button
              type="button"
              className="ij-pill"
              aria-pressed={range === r}
              key={r}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
          {UNITS.map((u) => (
            <button
              type="button"
              className="ij-pill"
              aria-pressed={unit === u}
              key={u}
              onClick={() => setUnit(u)}
            >
              {u}
            </button>
          ))}
        </div>
      </div>
      <div className="ij-main">
        <div>
          {mode === "timeline" ? (
            <Timeline
              data={data}
              weights={weights}
              selected={selected}
              onSelect={select}
              unit={unit}
              range={range}
              now={now}
            />
          ) : (
            <Calendar data={data} weights={weights} selected={selected} onSelect={select} />
          )}
          {stats && (
            <div className="ij-card" style={{ marginTop: 18 }}>
              <h3>Weight through this course</h3>
              <div className="ij-row">
                <span>Start {number(stats.first.kg * LB_PER_KG, 1)} lb</span>
                <span>Low {number(stats.low * LB_PER_KG, 1)} lb</span>
                <span>
                  Average {number(stats.weekly === null ? null : stats.weekly * LB_PER_KG, 1)}{" "}
                  lb/week
                </span>
              </div>
            </div>
          )}
          <div className="ij-card" style={{ marginTop: 18 }}>
            <h3>Vials</h3>
            {data.vials.map((v) => (
              <div key={v.id} className="ij-row">
                <span>
                  {v.label} · {number(usedVolume(v, data.injections))} / {v.volume} mL used
                  {v.retired ? " · retired" : ""}
                  {v.discardDate ? ` · discard ${v.discardDate}` : ""}
                </span>
                <Button variant="ghost" onClick={() => onAction({ kind: "vial", id: v.id })}>
                  Edit vial
                </Button>
              </div>
            ))}
            <Button variant="ghost" onClick={() => onAction({ kind: "vial" })}>
              Add vial
            </Button>
          </div>
        </div>
        <Inspector
          data={data}
          weights={weights}
          selected={selected}
          onLog={() => onAction({ kind: "injection" })}
          onCheckIn={() => {
            onAction({ kind: "checkin", date: dayAt(selected, c.timezone) });
          }}
          onEdit={(id) => onAction({ kind: "injection", id })}
        />
      </div>
      {c.notes && (
        <div className="ij-note">
          <strong>Course notes</strong>
          <p>{c.notes}</p>
        </div>
      )}
    </>
  );
}
function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="ij-stat">
      <span className="ij-eyebrow">{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function CoursePage({
  course,
  defaults,
  onCourseSaved,
}: {
  course: Course;
  defaults: Settings;
  onCourseSaved: (id?: string) => void;
}) {
  const [screen, setScreen] = useState<Screen>({ kind: "timeline" });
  const [checkDate, setCheckDate] = useState(dayAt(Date.now(), course.timezone));
  const [selectedPhotoDate, setSelectedPhotoDate] = useState(Date.now());
  const query = trpc.injections.detail.useQuery(
    { courseId: course.id },
    { refetchInterval: 60000 },
  );
  const weights = trpc.weight.timeline.useQuery(
    {
      from: new Date(zonedTime(course.startDate, "00:00", course.timezone)).toISOString(),
      to: new Date(
        Math.max(
          Date.now() + DAY,
          zonedTime(
            addDays(course.startDate, Math.max(...course.stages.map((s) => s.endWeek)) * 7 + 1),
            "00:00",
            course.timezone,
          ),
        ),
      ).toISOString(),
    },
    { refetchInterval: 60000, enabled: course.status !== "scenario" },
  );
  const utils = trpc.useUtils(),
    now = useNow();
  const refresh = () => {
    void utils.injections.detail.invalidate({ courseId: course.id });
    void utils.injections.list.invalidate();
  };
  const done = () => {
    refresh();
    setScreen({ kind: "timeline" });
  };
  if (query.error) return <ErrorMessage error={query.error} />;
  if (!query.data) return <p className="ij-muted">Loading course…</p>;
  const data = query.data,
    rows = weights.data ?? [];
  const action = (next: Screen) => {
    if (next.kind === "checkin") setCheckDate(next.date ?? dayAt(Date.now(), course.timezone));
    setScreen(next);
  };
  if (screen.kind === "course")
    return (
      <CourseForm
        course={data.course}
        defaults={defaults}
        onDone={(id) => {
          done();
          onCourseSaved(id);
        }}
      />
    );
  if (screen.kind === "injection")
    return <InjectionForm data={data} id={screen.id} onDone={done} />;
  if (screen.kind === "vial")
    return <VialForm data={data} vial={data.vials.find((v) => v.id === screen.id)} onDone={done} />;
  if (screen.kind === "checkin")
    return <CheckInForm data={data} date={checkDate} weights={rows} onDone={done} />;
  return (
    <>
      <ErrorMessage error={weights.error} />
      <TrackerView
        data={data}
        weights={rows}
        now={now.getTime()}
        onAction={action}
        onSelected={setSelectedPhotoDate}
      />
      {data.course.status !== "scenario" && (
        <div style={{ marginTop: 24 }}>
          <Photos data={data} weights={rows} selected={selectedPhotoDate} onRefresh={refresh} />
        </div>
      )}
      <div style={{ marginTop: 24 }}>
        <ScenarioComparison timezone={data.course.timezone} />
      </div>
    </>
  );
}
export function InjectionPage() {
  const query = trpc.injections.list.useQuery();
  const [selected, setSelected] = useState<string | null>(null),
    [create, setCreate] = useState(false),
    [error, setError] = useState<unknown>(null);
  const save = trpc.injections.saveCourse.useMutation(),
    utils = trpc.useUtils();
  const data = query.data;
  if (query.error)
    return (
      <div className="ij">
        <ErrorMessage error={query.error} />
      </div>
    );
  if (!data) return <div className="ij">Loading injection tracker…</div>;
  const course =
    data.courses.find((c) => c.id === selected) ??
    [...data.courses].reverse().find((c) => c.status === "active") ??
    data.courses.at(-1);
  const saved = (id?: string) => {
    void utils.injections.list.invalidate();
    setCreate(false);
    if (id) setSelected(id);
  };
  async function seed() {
    try {
      for (const preset of ["2024", "2026"] as const) {
        if (
          data?.courses.some(
            (c) => c.status === "scenario" && c.name === `${preset} prescribed scenario`,
          )
        )
          continue;
        await save.mutateAsync({
          config: scenario(
            preset,
            preset === "2024" ? "2024-07-05" : "2026-09-04",
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          ),
        });
      }
      void utils.injections.list.invalidate();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <div className="ij">
      {create ? (
        <CourseForm defaults={data.settings} onDone={saved} />
      ) : (
        <>
          <div className="ij-row">
            <label className="ij-field" style={{ margin: 0, minWidth: 300 }}>
              <span>Course history</span>
              <select
                aria-label="Course history"
                value={course?.id ?? ""}
                onChange={(e) => setSelected(e.target.value)}
              >
                {!course && <option value="">No courses yet</option>}
                {data.courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.startDate} · {c.status}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="ghost" onClick={() => setCreate(true)}>
              New course
            </Button>
          </div>
          {course ? (
            <CoursePage
              key={course.id}
              course={course}
              defaults={data.settings}
              onCourseSaved={saved}
            />
          ) : (
            <div className="ij-empty">
              <span className="ij-eyebrow">INJECTIONS · WEIGHT · HOW YOU FEEL</span>
              <h1>Your course, in one timeline.</h1>
              <p className="ij-muted">
                Keep your plan, actual injections, vial usage, weight and progress photos together.
                Start with your regimen or inspect the supplied scenarios.
              </p>
              <Button onClick={() => setCreate(true)}>Start your course</Button>
              <ScenarioComparison timezone={Intl.DateTimeFormat().resolvedOptions().timeZone} />
            </div>
          )}
          <div className="ij-history">
            <Button variant="ghost" loading={save.isPending} onClick={() => void seed()}>
              Add 2024 & 2026 scenario courses
            </Button>
            <ErrorMessage error={error} />
          </div>
        </>
      )}
    </div>
  );
}
export const injectionDetail: TileDetailPageEntry = {
  kind: "page",
  tileId: "tile_injections",
  title: "Injection tracker",
  defaultSlug: "timeline",
  useVariants: () => ({
    variants: [{ slug: "timeline", label: "Timeline", render: () => <InjectionPage /> }],
    loading: false,
  }),
};
