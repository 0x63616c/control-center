import { useState } from "react";
import { Slider } from "@/components/ui/Slider";
import { DAY, LB_PER_KG, projectedDoses, type RecordSet, remaining, type Weight } from "../model";
import { dateLabel, number } from "./Timeline";

export function ProgressGraph({
  data,
  weights,
  now,
}: {
  data: RecordSet;
  weights: Weight[];
  now: number;
}) {
  const [selected, setSelected] = useState(now);
  const [weeks, setWeeks] = useState(4);
  const { actual, future, projected } = projectedDoses(data, now);
  const left = now - weeks * 7 * DAY;
  const right = now + weeks * 7 * DAY;
  const times = new Set([left, now, right]);
  for (let t = left; t < right; t += DAY / 4) times.add(t);
  for (const d of projected) {
    const t = Date.parse(d.at);
    if (t > left && t <= right) {
      times.add(t - 1);
      times.add(t);
    }
  }
  const samples = [...times]
    .sort((a, b) => a - b)
    .map((at) => ({ at, mg: remaining(projected, at, data.course.halfLifeDays) ?? 0 }));
  const max = Math.max(0.1, ...samples.map((s) => s.mg));
  const x = (at: number) => 50 + ((at - left) / (right - left)) * 900;
  const y = (mg: number) => 220 - (mg / max) * 170;
  const path = (rows: typeof samples) =>
    rows.map((s, i) => `${i ? "L" : "M"}${x(s.at)},${y(s.mg)}`).join(" ");
  const at = Math.max(left, Math.min(right, selected));
  const known = samples.filter((s) => s.at <= now);
  const prediction = samples.filter((s) => s.at >= now);
  const amount = remaining(at > now ? projected : actual, at, data.course.halfLifeDays);
  const visibleWeights = weights.filter((w) => Date.parse(w.at) >= left && Date.parse(w.at) <= now);
  const selectedWeight = weights.filter((w) => Date.parse(w.at) <= Math.min(at, now)).at(-1);
  const low = Math.min(...visibleWeights.map((w) => w.kg));
  const high = Math.max(...visibleWeights.map((w) => w.kg));
  const wy = (kg: number) => 385 - ((kg - low) / (high - low || 1)) * 65;
  return (
    <section className="ij-progress">
      <div className="ij-row">
        <h2>Medication & weight</h2>
        <div className="ij-actions">
          {[4, 12].map((w) => (
            <button
              className="ij-pill"
              type="button"
              key={w}
              aria-pressed={weeks === w}
              onClick={() => setWeeks(w)}
            >
              {w} weeks each side
            </button>
          ))}
        </div>
      </div>
      <p className="ij-muted">
        Solid: estimate from logged doses · Dashed: forecast if you follow your schedule
      </p>
      <svg
        viewBox="0 0 1000 430"
        role="img"
        aria-label="Medication remaining and synced weight, with future medication forecast"
        style={{ width: "100%", display: "block", touchAction: "pan-y" }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const r = e.currentTarget.getBoundingClientRect();
          setSelected(
            left +
              Math.max(0, Math.min(1, (((e.clientX - r.left) / r.width) * 1000 - 50) / 900)) *
                (right - left),
          );
        }}
        onPointerMove={(e) => {
          if (!e.buttons) return;
          const r = e.currentTarget.getBoundingClientRect();
          setSelected(
            left +
              Math.max(0, Math.min(1, (((e.clientX - r.left) / r.width) * 1000 - 50) / 900)) *
                (right - left),
          );
        }}
      >
        <rect x={x(now)} y="30" width={950 - x(now)} height="200" fill="var(--acc)" opacity=".04" />
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1="50" x2="950" y1={y(max * f)} y2={y(max * f)} stroke="var(--hair)" />
            <text x="42" y={y(max * f) + 4} textAnchor="end" fill="var(--ink-2)" fontSize="12">
              {number(max * f)}
            </text>
          </g>
        ))}
        <text x="50" y="20" fill="var(--ink-2)" fontSize="13">
          Estimated amount · mg
        </text>
        {data.course.halfLifeDays !== null && (
          <>
            <path d={path(known)} stroke="var(--acc)" strokeWidth="3" fill="none" />
            <path
              d={path(prediction)}
              stroke="var(--acc)"
              strokeWidth="3"
              strokeDasharray="6 5"
              fill="none"
            />
          </>
        )}
        {actual
          .filter((d) => Date.parse(d.at) >= left)
          .map((d) => (
            <circle key={d.id} cx={x(Date.parse(d.at))} cy="245" r="4" fill="var(--acc)">
              <title>{d.units} units logged</title>
            </circle>
          ))}
        {future
          .filter((d) => Date.parse(d.at) <= right)
          .map((d) => (
            <circle
              key={d.at}
              cx={x(Date.parse(d.at))}
              cy="245"
              r="4"
              fill="none"
              stroke="var(--ink-2)"
            >
              <title>{d.units} units planned</title>
            </circle>
          ))}
        <text x="50" y="283" fill="var(--ink-2)" fontSize="13">
          Weight · lb · synced from Weight
        </text>
        {visibleWeights.length > 0 ? (
          <>
            <path
              d={visibleWeights
                .map((w, i) => `${i ? "L" : "M"}${x(Date.parse(w.at))},${wy(w.kg)}`)
                .join(" ")}
              fill="none"
              stroke="#d4b178"
              strokeWidth="2"
            />
            {visibleWeights.map((w) => (
              <circle key={w.id} cx={x(Date.parse(w.at))} cy={wy(w.kg)} r="3" fill="#d4b178">
                <title>{number(w.kg * LB_PER_KG, 1)} lb</title>
              </circle>
            ))}
          </>
        ) : (
          <text x="50" y="345" fill="var(--ink-2)" fontSize="14">
            No weight readings in this window yet
          </text>
        )}
        <line
          x1={x(now)}
          x2={x(now)}
          y1="28"
          y2="390"
          stroke="var(--ink-2)"
          strokeDasharray="2 5"
        />
        <text x={x(now) + 8} y="20" fill="var(--ink)" fontSize="13">
          Now → forecast
        </text>
        <line x1={x(at)} x2={x(at)} y1="30" y2="390" stroke="var(--ink)" opacity=".6" />
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <text
            key={f}
            x={x(left + (right - left) * f)}
            y="417"
            textAnchor="middle"
            fill="var(--ink-2)"
            fontSize="12"
          >
            {dateLabel(left + (right - left) * f, data.course.timezone)}
          </text>
        ))}
      </svg>
      <Slider
        label="Explore progress"
        min={left}
        max={right}
        step={3600000}
        value={at}
        onChange={setSelected}
        format={(v) => dateLabel(v, data.course.timezone)}
      />
      <div className="ij-row ij-graph-caption">
        <span>
          {dateLabel(at, data.course.timezone)} · {at > now ? "Forecast" : "From logged doses"}
        </span>
        <strong>
          {number(amount)} mg ·{" "}
          {selectedWeight
            ? `${number(selectedWeight.kg * LB_PER_KG, 1)} lb (${dateLabel(selectedWeight.at, data.course.timezone)})`
            : "No weight reading"}
        </strong>
      </div>
      <p className="ij-muted">
        {data.course.halfLifeDays === null
          ? "Set a half-life in settings to see an estimate."
          : `${data.course.halfLifeDays}-day half-life estimate, not a measured drug level. Future doses are assumptions, not logged history.`}
      </p>
    </section>
  );
}
