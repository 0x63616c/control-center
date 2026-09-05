import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  addDays,
  courseWeek,
  DAY,
  dayAt,
  doses,
  LB_PER_KG,
  plannedInjections,
  type RecordSet,
  remaining,
  type Settings,
  usedVolume,
  type Weight,
  weightStats,
  zonedTime,
} from "../model";

export function number(value: number | null | undefined, digits = 2): string {
  return value == null ? "—" : value.toFixed(digits).replace(/\.00$/, "");
}
export function dateLabel(at: string | number, tz: string): string {
  return new Date(at).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
}
export function Timeline({
  data,
  weights,
  selected,
  onSelect,
  unit,
  range,
  now,
}: {
  data: RecordSet;
  weights: Weight[];
  selected: number;
  onSelect: (at: number) => void;
  unit: Settings["primaryUnit"];
  range: Settings["range"];
  now: number;
}) {
  const c = data.course;
  const plan = useMemo(() => plannedInjections(c), [c]);
  const actual = useMemo(() => doses(data), [data]);
  const scenario = c.status === "scenario";
  const events = scenario ? plan : actual;
  const start = zonedTime(c.startDate, "00:00", c.timezone);
  const end = Math.max(
    start + DAY,
    Date.parse(plan.at(-1)?.at ?? new Date(now).toISOString()) + DAY,
    ...actual.map((i) => Date.parse(i.at) + DAY),
  );
  const left = range === "All" ? Math.min(start, ...weights.map((w) => Date.parse(w.at))) : start;
  const right =
    range === "4W"
      ? start + 28 * DAY
      : range === "12W"
        ? start + 84 * DAY
        : range === "All"
          ? Math.max(end, now)
          : end;
  const x = (at: number) => 64 + ((at - left) / (right - left)) * 920;
  const value = (d: { units: number; mg: number; ml: number }) =>
    unit === "mg" ? d.mg : unit === "mL" ? d.ml : d.units;
  const maxDose = Math.max(0.01, ...plan.map(value), ...actual.map(value));
  // Include both sides of every event so even a sub-day injection has an exact vertical jump.
  const samples = useMemo(() => {
    const times = new Set<number>([left, right]);
    const step = Math.max(DAY / 4, (right - left) / 1000);
    for (let t = left; t <= right; t += step) times.add(t);
    for (const e of events) {
      const t = Date.parse(e.at);
      if (t >= left && t <= right) {
        times.add(t - 1);
        times.add(t);
      }
    }
    return [...times]
      .sort((a, b) => a - b)
      .map((at) => ({ at, mg: remaining(events, at, c.halfLifeDays) ?? 0 }));
  }, [events, left, right, c.halfLifeDays]);
  const maxBurden = Math.max(0.01, ...samples.map((p) => p.mg));
  const visibleWeights = scenario
    ? []
    : weights.filter((w) => Date.parse(w.at) >= left && Date.parse(w.at) <= right);
  const minKg = Math.min(...visibleWeights.map((w) => w.kg)),
    maxKg = Math.max(...visibleWeights.map((w) => w.kg));
  const yWeight = (kg: number) => 446 - ((kg - minKg) / (maxKg - minKg || 1)) * 68;
  const activeVial = data.vials.find((v) => !v.retired) ?? data.vials.at(-1);
  const vialRemaining = (at: number) =>
    activeVial
      ? Math.max(0, activeVial.volume - usedVolume(activeVial, data.injections, at)) /
        activeVial.volume
      : 0;
  const path = (points: { x: number; y: number }[]) =>
    points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const burdenPath = path(samples.map((p) => ({ x: x(p.at), y: 230 - (p.mg / maxBurden) * 74 })));
  const pick = (clientX: number, rect: DOMRect) =>
    onSelect(
      Math.min(
        right,
        Math.max(
          left,
          left + ((((clientX - rect.left) / rect.width) * 1000 - 64) / 920) * (right - left),
        ),
      ),
    );
  const cursor = Math.max(64, Math.min(984, x(selected)));
  return (
    <section className="ij-chart" aria-label="Synchronized medication timeline">
      <div className="ij-row">
        <span className="ij-muted">
          {scenario
            ? "Scenario projection · no actual injections"
            : "Dashed: planned · solid: recorded"}
        </span>
        <span className="ij-muted">Tap or drag across all four charts</span>
      </div>
      <svg
        viewBox="0 0 1000 485"
        role="img"
        aria-label="Dose, estimated remaining, vial and weight with shared date cursor"
        style={{ width: "100%", touchAction: "pan-y", display: "block" }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pick(e.clientX, e.currentTarget.getBoundingClientRect());
        }}
        onPointerMove={(e) => {
          if (e.buttons) pick(e.clientX, e.currentTarget.getBoundingClientRect());
        }}
      >
        <defs>
          <linearGradient id="ij-burden-fill" x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="var(--acc)" stopOpacity=".4" />
            <stop offset="1" stopColor="var(--acc)" stopOpacity=".02" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4, 5, 6].map((i) => {
          const at = left + ((right - left) * i) / 6;
          return (
            <g key={i}>
              <line x1={x(at)} x2={x(at)} y1="24" y2="451" stroke="var(--hair)" />
              <text
                x={x(at)}
                y="478"
                textAnchor={i === 6 ? "end" : "start"}
                fill="var(--ink-2)"
                fontSize="12"
              >
                {dateLabel(at, c.timezone)}
              </text>
            </g>
          );
        })}
        {[
          { y: 27, label: `Dose · ${unit}` },
          { y: 146, label: `Estimated ${c.medication.toLowerCase()} remaining · mg` },
          { y: 260, label: `${activeVial?.label ?? "Vial"} · remaining %` },
          { y: 370, label: "Weight · lb" },
        ].map((l) => (
          <text key={l.y} x="64" y={l.y} fill="var(--ink-2)" fontSize="14">
            {l.label}
          </text>
        ))}
        <line x1="64" x2="984" y1="116" y2="116" stroke="var(--hair-2)" />
        {plan
          .filter((p) => Date.parse(p.at) >= left && Date.parse(p.at) <= right)
          .map((p) => (
            <line
              key={p.at}
              x1={x(Date.parse(p.at))}
              x2={x(Date.parse(p.at))}
              y1="116"
              y2={116 - (value(p) / maxDose) * 74}
              stroke="var(--ink-2)"
              strokeWidth="3"
              strokeDasharray="3 4"
            />
          ))}
        {actual
          .filter((p) => Date.parse(p.at) >= left && Date.parse(p.at) <= right)
          .map((p) => (
            <g key={p.id}>
              <line
                x1={x(Date.parse(p.at))}
                x2={x(Date.parse(p.at))}
                y1="116"
                y2={116 - (value(p) / maxDose) * 74}
                stroke="var(--acc)"
                strokeWidth="4"
              />
              <circle
                cx={x(Date.parse(p.at))}
                cy={116 - (value(p) / maxDose) * 74}
                r="5"
                fill="var(--acc)"
              />
            </g>
          ))}
        <text x="14" y="52" fill="var(--ink-2)" fontSize="12">
          {number(maxDose)}
        </text>
        {c.halfLifeDays === null ? (
          <text x="64" y="198" fill="var(--ink-2)">
            No half-life configured for this medication
          </text>
        ) : (
          <>
            <path d={`${burdenPath} L984,232 L64,232 Z`} fill="url(#ij-burden-fill)" />
            <path d={burdenPath} fill="none" stroke="var(--acc)" strokeWidth="2.5" />
            <text x="14" y="165" fill="var(--ink-2)" fontSize="12">
              {number(maxBurden)}
            </text>
          </>
        )}
        {activeVial && !scenario ? (
          <path
            d={path(samples.map((p) => ({ x: x(p.at), y: 342 - vialRemaining(p.at) * 66 })))}
            fill="none"
            stroke="#9b8de5"
            strokeWidth="2.5"
          />
        ) : (
          <text x="64" y="310" fill="var(--ink-2)">
            {scenario
              ? `${number(plan.reduce((s, p) => s + p.ml, 0))} mL planned consumption`
              : "Add a vial to track remaining volume"}
          </text>
        )}
        <text x="14" y="285" fill="var(--ink-2)" fontSize="12">
          100
        </text>
        {visibleWeights.length ? (
          <>
            {visibleWeights.map((w) => (
              <circle key={w.id} cx={x(Date.parse(w.at))} cy={yWeight(w.kg)} r="4" fill="#d6aa65" />
            ))}
            <text x="14" y="390" fill="var(--ink-2)" fontSize="12">
              {number(maxKg * LB_PER_KG, 0)}
            </text>
          </>
        ) : (
          <text x="64" y="413" fill="var(--ink-2)">
            {scenario
              ? "Scenarios do not invent weight history"
              : "No included weight readings in this range"}
          </text>
        )}
        {data.checkIns.map((entry) => {
          const at = zonedTime(entry.date, "12:00", c.timezone);
          return at >= left && at <= right ? (
            <circle key={entry.id} cx={x(at)} cy="457" r="3" fill="var(--acc)" />
          ) : null;
        })}
        <line x1={cursor} x2={cursor} y1="30" y2="454" stroke="var(--ink)" strokeWidth="1.5" />
        <circle cx={cursor} cy="454" r="5" fill="var(--ink)" />
      </svg>
      <input
        aria-label="Selected timeline date"
        type="range"
        min={left}
        max={right}
        step={3600000}
        value={Math.min(right, Math.max(left, selected))}
        onChange={(e) => onSelect(Number(e.target.value))}
      />
    </section>
  );
}

export function Inspector({
  data,
  weights,
  selected,
  onLog,
  onCheckIn,
  onEdit,
}: {
  data: RecordSet;
  weights: Weight[];
  selected: number;
  onLog: () => void;
  onCheckIn: () => void;
  onEdit: (id: string) => void;
}) {
  const c = data.course,
    day = dayAt(selected, c.timezone),
    week = courseWeek(c, selected),
    actual = doses(data),
    plan = plannedInjections(c);
  const dayDoses = actual.filter((i) => dayAt(i.at, c.timezone) === day),
    dayPlans = plan.filter((i) => dayAt(i.at, c.timezone) === day);
  const weeklyActual = actual.filter((i) => courseWeek(c, Date.parse(i.at)) === week),
    weeklyPlan = plan.filter((i) => i.week === week);
  const estimate = remaining(c.status === "scenario" ? plan : actual, selected, c.halfLifeDays);
  const last = actual.filter((i) => Date.parse(i.at) <= selected).at(-1);
  const previous = last
    ? remaining(
        actual.filter((i) => i.id !== last.id),
        selected,
        c.halfLifeDays,
      )
    : null;
  const stats = c.status === "scenario" ? null : weightStats(weights, c, selected);
  const check = data.checkIns.find((e) => e.date === day);
  const photos = [...data.photos].sort(
    (a, b) => Math.abs(Date.parse(a.at) - selected) - Math.abs(Date.parse(b.at) - selected),
  );
  return (
    <aside className="ij-inspector">
      <span className="ij-eyebrow">SELECTED MOMENT · WEEK {week}</span>
      <h2>
        {new Date(selected).toLocaleString("en-US", {
          timeZone: c.timezone,
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
      </h2>
      <dl className="ij-facts">
        <dt>Planned this week</dt>
        <dd>
          {number(weeklyPlan.reduce((s, i) => s + i.units, 0))} units ·{" "}
          {number(weeklyPlan.reduce((s, i) => s + i.mg, 0))} mg
        </dd>
        <dt>Actual this week</dt>
        <dd>
          {number(weeklyActual.reduce((s, i) => s + i.units, 0))} units ·{" "}
          {number(weeklyActual.reduce((s, i) => s + i.mg, 0))} mg
        </dd>
        <dt>{c.status === "scenario" ? "Projected remaining" : "Estimated remaining"}</dt>
        <dd>{number(estimate)} mg</dd>
        {last && (
          <>
            <dt>Last injection</dt>
            <dd>
              {number(last.mg)} mg · {number((selected - Date.parse(last.at)) / DAY, 1)} days ago
            </dd>
            <dt>Previous doses contribute</dt>
            <dd>{number(previous)} mg</dd>
          </>
        )}
        {data.vials.map((v) => (
          <VialFact key={v.id} vial={v} data={data} at={selected} />
        ))}
        <dt>Weight at / before selection</dt>
        <dd>
          {stats
            ? `${number(stats.last.kg * LB_PER_KG, 1)} lb · ${dateLabel(stats.last.at, c.timezone)}`
            : "No course reading"}
        </dd>
        {stats && (
          <>
            <dt>Change from first course reading</dt>
            <dd>
              {number(stats.change * LB_PER_KG, 1)} lb · {number(stats.percent, 1)}%
            </dd>
          </>
        )}
      </dl>
      {dayPlans.map((p) => (
        <p className="ij-muted" key={p.at}>
          Planned {number(p.units)} units · {number(p.mg)} mg{" "}
          {actual.some((i) => i.plannedAt && Date.parse(i.plannedAt) === Date.parse(p.at))
            ? "· linked to record"
            : Date.parse(p.at) < Date.now()
              ? "· no linked record"
              : "· upcoming"}
        </p>
      ))}
      {dayDoses.map((i) => (
        <button type="button" className="ij-event" key={i.id} onClick={() => onEdit(i.id)}>
          <strong>
            {number(i.units)} units · {number(i.mg)} mg
          </strong>
          <span>
            {new Date(i.at).toLocaleTimeString("en-US", {
              timeZone: c.timezone,
              hour: "numeric",
              minute: "2-digit",
            })}{" "}
            · {number(i.ml)} mL · Edit
          </span>
          {i.notes && <span>{i.notes}</span>}
        </button>
      ))}
      {check && (
        <div className="ij-note">
          <strong>Daily check-in</strong>
          {Object.entries(check.values).map(([key, value]) => (
            <div key={key}>
              {key}: {value}/4
            </div>
          ))}
          <p>{check.notes}</p>
          {check.weightId && <small>Note linked to a weight reading</small>}
        </div>
      )}
      {photos[0] && (
        <figure>
          <img
            className="ij-thumb"
            src={`/media/progress-photos/${photos[0].id}`}
            alt={`Closest progress photo, ${photos[0].pose}`}
          />
          <figcaption>Closest photo · {dateLabel(photos[0].at, c.timezone)}</figcaption>
        </figure>
      )}
      {c.status !== "scenario" && (
        <div className="ij-actions">
          <Button type="button" onClick={onLog}>
            Log injection
          </Button>
          <Button type="button" variant="ghost" onClick={onCheckIn}>
            {check ? "Edit check-in" : "Check in / add note"}
          </Button>
        </div>
      )}
      <p className="ij-muted">
        {c.halfLifeDays ?? "No"}-day half-life model. An estimate of amount remaining, not measured
        blood concentration or dosing guidance.
      </p>
    </aside>
  );
}
function VialFact({
  vial,
  data,
  at,
}: {
  vial: RecordSet["vials"][number];
  data: RecordSet;
  at: number;
}) {
  const used = usedVolume(vial, data.injections, at);
  return (
    <>
      <dt>{vial.label} used / remaining</dt>
      <dd>
        {number(used)} / {number(vial.volume - used)} mL ·{" "}
        {number((1 - used / vial.volume) * 100, 0)}% left
      </dd>
    </>
  );
}

export function Calendar({
  data,
  weights,
  selected,
  onSelect,
}: {
  data: RecordSet;
  weights: Weight[];
  selected: number;
  onSelect: (at: number) => void;
}) {
  const c = data.course,
    day = dayAt(selected, c.timezone),
    first = `${day.slice(0, 7)}-01`;
  const weekday = new Date(`${first}T12:00:00Z`).getUTCDay(),
    start = addDays(first, -((weekday + 6) % 7));
  const plan = plannedInjections(c),
    actual = doses(data);
  const move = (months: number) => {
    const d = new Date(`${first}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + months);
    onSelect(zonedTime(d.toISOString().slice(0, 10), "12:00", c.timezone));
  };
  return (
    <section>
      <div className="ij-row">
        <Button variant="ghost" onClick={() => move(-1)}>
          Previous month
        </Button>
        <h2>
          {new Date(`${first}T12:00:00Z`).toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
            timeZone: "UTC",
          })}
        </h2>
        <Button variant="ghost" onClick={() => move(1)}>
          Next month
        </Button>
      </div>
      <div className="ij-calendar">
        {["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((d) => (
          <span className="ij-eyebrow" key={d}>
            {d}
          </span>
        ))}
        {Array.from({ length: 42 }, (_, i) => {
          const date = addDays(start, i),
            p = plan.filter((p) => dayAt(p.at, c.timezone) === date),
            a = actual.filter((a) => dayAt(a.at, c.timezone) === date),
            w = weights.filter((w) => dayAt(w.at, c.timezone) === date);
          return (
            <button
              type="button"
              key={date}
              className={`ij-day ${date === day ? "selected" : ""}`}
              style={{ opacity: date.slice(0, 7) === first.slice(0, 7) ? 1 : 0.45 }}
              onClick={() => onSelect(zonedTime(date, "23:59", c.timezone))}
            >
              <strong>{Number(date.slice(8))}</strong>
              {p.map((e) => (
                <span className="ij-muted" key={e.at}>
                  ○ {number(e.units)}u planned
                </span>
              ))}
              {a.map((e) => (
                <span className="ij-accent" key={e.id}>
                  ● {number(e.units)}u · {number(e.mg)}mg
                </span>
              ))}
              {p.some(
                (e) =>
                  Date.parse(e.at) < Date.now() &&
                  !actual.some((a) => a.plannedAt && Date.parse(a.plannedAt) === Date.parse(e.at)),
              ) && <small>No linked record</small>}
              {w.length > 0 && <small>Weight ●</small>}
              {data.checkIns.some((e) => e.date === date) && <small>Check-in ●</small>}
              {data.photos.some((e) => dayAt(e.at, c.timezone) === date) && <small>Photo ●</small>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function ScenarioComparison({ timezone }: { timezone: string }) {
  const [at, setAt] = useState(28);
  const prescribed = (old: boolean) =>
    Array.from({ length: 12 }, (_, i) => ({
      at: new Date(i * 7 * DAY).toISOString(),
      mg: (old ? (i < 4 ? 5 : i < 8 ? 10 : 20) : i < 4 ? 3 : 8) / 20,
    }));
  const old = prescribed(true),
    current = prescribed(false);
  const path = (events: typeof old) =>
    Array.from({ length: 337 }, (_, i) => {
      const day = i / 4;
      return `${i ? "L" : "M"}${40 + (day / 84) * 900},${210 - ((remaining(events, day * DAY, 7) ?? 0) / 2) * 180}`;
    }).join(" ");
  return (
    <section className="ij-card">
      <h2>12-week schedule comparison</h2>
      <p className="ij-muted">
        Modeled prescribed scenarios, aligned to day 0. These curves assume every planned injection;
        they are not your actual history.
      </p>
      <div className="ij-row">
        <span>2024 · 0.25 → 0.50 → 1.00 mg/week</span>
        <span className="ij-accent">2026 · 0.15 → 0.40 mg/week</span>
      </div>
      <svg viewBox="0 0 1000 240" role="img" aria-label="2024 and 2026 modeled amount remaining">
        <path d={path(old)} stroke="#b79ae9" strokeWidth="3" fill="none" />
        <path d={path(current)} stroke="var(--acc)" strokeWidth="3" fill="none" />
        <line
          x1={40 + (at / 84) * 900}
          x2={40 + (at / 84) * 900}
          y1="10"
          y2="210"
          stroke="var(--ink)"
        />
        {[0, 4, 8, 12].map((w) => (
          <text key={w} x={40 + (w / 12) * 900} y="235" fill="var(--ink-2)" textAnchor="middle">
            W{w}
          </text>
        ))}
      </svg>
      <input
        type="range"
        aria-label="Comparison day"
        min="0"
        max="84"
        step="0.25"
        value={at}
        onChange={(e) => setAt(Number(e.target.value))}
      />
      <div className="ij-row">
        <strong>Day {number(at, 1)}</strong>
        <span>2024: {number(remaining(old, at * DAY, 7))} mg remaining</span>
        <span>2026: {number(remaining(current, at * DAY, 7))} mg remaining</span>
      </div>
      <p className="ij-muted">
        12-week totals: 2024 · 7 mg / 1.4 mL; 2026 · 3.8 mg / 0.76 mL. Schedule dates use {timezone}
        .
      </p>
    </section>
  );
}
