import { useState } from "react";
import type { TileDetailPageEntry } from "@/components/tiles/detail/types";
import { Button } from "@/components/ui/Button";
import { useNow } from "@/lib/hooks";
import { trpc } from "@/lib/trpc";
import {
  addDays,
  type Course,
  dayAt,
  doses,
  LB_PER_KG,
  projectedDoses,
  type RecordSet,
  remaining,
  type Settings,
  scenario,
  type Weight,
  weightStats,
  zonedTime,
} from "./model";
import { CourseHero } from "./web/CourseHero";
import { CheckInForm, CourseForm, ErrorMessage, InjectionForm, VialForm } from "./web/Forms";
import { Photos } from "./web/Photos";
import { ProgressGraph } from "./web/Progress";
import { QuickStart } from "./web/QuickStart";
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
  const actual = doses(data);
  const last = actual.filter((d) => Date.parse(d.at) <= now).at(-1);
  const estimate = remaining(actual, now, c.halfLifeDays);
  const next = projectedDoses(data, now).future[0];
  const stats = weightStats(weights, c, now);
  const latestWeight = weights.filter((w) => Date.parse(w.at) <= now).at(-1);
  const [selected, setSelected] = useState(now);
  return (
    <>
      <div className="ij-row ij-top">
        <div>
          <span className="ij-eyebrow">{c.medication}</span>
          <h1>Your progress</h1>
        </div>
        <Button onClick={() => onAction({ kind: "injection" })}>Log dose</Button>
      </div>
      <section className="ij-simple-summary">
        <div className="ij-body-estimate">
          <span className="ij-muted">Estimated in your body now</span>
          <div className="ij-big-number">
            {actual.length ? number(estimate) : "—"}
            <small>mg</small>
          </div>
          <span className="ij-muted">
            {actual.length
              ? "Based on your logged doses"
              : "Log your first dose to start the estimate"}
          </span>
        </div>
        <div>
          <span className="ij-muted">Last dose</span>
          <strong>{last ? `${last.units} units` : "Nothing logged yet"}</strong>
          <span className="ij-muted">
            {last
              ? new Date(last.at).toLocaleString("en-US", {
                  timeZone: c.timezone,
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })
              : "Ready when you are"}
          </span>
        </div>
        <div>
          <span className="ij-muted">Weight · synced</span>
          <strong>
            {latestWeight ? `${number(latestWeight.kg * LB_PER_KG, 1)} lb` : "No readings yet"}
          </strong>
          <span className="ij-muted">
            {stats
              ? `${stats.change > 0 ? "+" : ""}${number(stats.change * LB_PER_KG, 1)} lb since ${dateLabel(stats.first.at, c.timezone)}`
              : "From your Weight tile"}
          </span>
        </div>
        <div>
          <span className="ij-muted">Next planned dose</span>
          <strong>{next ? `${next.units} units` : "No upcoming dose"}</strong>
          <span className="ij-muted">
            {next ? dateLabel(next.at, c.timezone) : "Adjust your schedule in More"}
          </span>
        </div>
      </section>
      <ProgressGraph data={data} weights={weights} now={now} />
      <section className="ij-recent">
        <div className="ij-row">
          <h2>Dose log</h2>
          <span className="ij-muted">Tap an entry to edit</span>
        </div>
        {[...actual]
          .reverse()
          .slice(0, 10)
          .map((d) => (
            <button
              type="button"
              className="ij-log-row"
              key={d.id}
              onClick={() => onAction({ kind: "injection", id: d.id })}
            >
              <strong>
                {d.units} units <small>· {number(d.mg)} mg</small>
              </strong>
              <span>
                {new Date(d.at).toLocaleString("en-US", {
                  timeZone: c.timezone,
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </button>
          ))}
        {!actual.length && (
          <p className="ij-muted">Your doses will appear here after you log them.</p>
        )}
      </section>
      <details className="ij-more">
        <summary>More · schedule, history & tools</summary>
        <div className="ij-actions">
          <Button variant="ghost" onClick={() => onAction({ kind: "course" })}>
            Edit schedule & settings
          </Button>
          <Button variant="ghost" onClick={() => onAction({ kind: "checkin" })}>
            Add check-in
          </Button>
          <Button variant="ghost" onClick={() => onAction({ kind: "vial" })}>
            Add vial
          </Button>
        </div>
        <CourseHero data={data} weights={weights} now={now} />
        {data.vials.map((v) => (
          <Button key={v.id} variant="ghost" onClick={() => onAction({ kind: "vial", id: v.id })}>
            Edit {v.label}
          </Button>
        ))}
        <Timeline
          data={data}
          weights={weights}
          selected={selected}
          onSelect={(at) => {
            setSelected(at);
            onSelected?.(at);
          }}
          unit={c.primaryUnit}
          range={c.range}
          now={now}
        />
        <Inspector
          data={data}
          weights={weights}
          selected={selected}
          onLog={() => onAction({ kind: "injection" })}
          onCheckIn={() => onAction({ kind: "checkin", date: dayAt(selected, c.timezone) })}
          onEdit={(id) => onAction({ kind: "injection", id })}
        />
        <Calendar data={data} weights={weights} selected={selected} onSelect={setSelected} />
      </details>
    </>
  );
}

function CoursePage({
  course,
  defaults,
  onCourseSaved,
  logFirst = false,
}: {
  course: Course;
  defaults: Settings;
  onCourseSaved: (id?: string) => void;
  logFirst?: boolean;
}) {
  const [screen, setScreen] = useState<Screen>({ kind: logFirst ? "injection" : "timeline" });
  const [checkDate, setCheckDate] = useState(dayAt(Date.now(), course.timezone));
  const [selectedPhotoDate, setSelectedPhotoDate] = useState(Date.now());
  const query = trpc.injections.detail.useQuery(
    { courseId: course.id },
    { refetchInterval: 60000 },
  );
  const weights = trpc.weight.timeline.useQuery(
    {
      from: new Date(
        zonedTime(addDays(course.startDate, -168), "00:00", course.timezone),
      ).toISOString(),
      to: new Date(
        Math.max(
          zonedTime(addDays(dayAt(Date.now(), course.timezone), 1), "00:00", course.timezone),
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
      <details className="ij-more">
        <summary>Progress photos & comparisons</summary>
        {data.course.status !== "scenario" && (
          <div style={{ marginTop: 24 }}>
            <Photos data={data} weights={rows} selected={selectedPhotoDate} onRefresh={refresh} />
          </div>
        )}
        <div style={{ marginTop: 24 }}>
          <ScenarioComparison timezone={data.course.timezone} />
        </div>
      </details>
    </>
  );
}
function InjectionPage() {
  const query = trpc.injections.list.useQuery();
  const [firstLog, setFirstLog] = useState<string | null>(null);
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
    [...data.courses].reverse().find((c) => c.status === "active");
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
          <details className="ij-more">
            <summary>Tracking settings & course history</summary>
            <label className="ij-field">
              <span>Course history</span>
              <select
                aria-label="Course history"
                value={course?.id ?? ""}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">Current tracking</option>
                {data.courses
                  .filter((c) => c.status !== "scenario")
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
            <Button variant="ghost" onClick={() => setCreate(true)}>
              New course
            </Button>
          </details>
          {course ? (
            <CoursePage
              key={course.id}
              logFirst={firstLog === course.id}
              course={course}
              defaults={data.settings}
              onCourseSaved={saved}
            />
          ) : (
            <QuickStart
              defaults={data.settings}
              onDone={(id) => {
                setFirstLog(id);
                saved(id);
              }}
            />
          )}
          <details className="ij-more">
            <summary>Example schedules</summary>
            <div className="ij-history">
              <Button variant="ghost" loading={save.isPending} onClick={() => void seed()}>
                Add 2024 & 2026 scenario courses
              </Button>
              <ErrorMessage error={error} />
              <ScenarioComparison timezone={Intl.DateTimeFormat().resolvedOptions().timeZone} />
            </div>
          </details>
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
