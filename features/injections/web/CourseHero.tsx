import { useId } from "react";
import {
  DAY,
  dayAt,
  doses,
  LB_PER_KG,
  plannedInjections,
  type RecordSet,
  remaining,
  usedVolume,
  type Weight,
  weightStats,
} from "../model";
import { dateLabel, number } from "./Timeline";

export function CourseHero({
  data,
  weights,
  now,
}: {
  data: RecordSet;
  weights: Weight[];
  now: number;
}) {
  const c = data.course,
    actual = doses(data),
    plan = plannedInjections(c),
    today = dayAt(now, c.timezone);
  const next = plan.find(
    (p) =>
      dayAt(p.at, c.timezone) >= today &&
      !actual.some((i) => i.plannedAt && Date.parse(i.plannedAt) === Date.parse(p.at)),
  );
  const last = actual.filter((i) => Date.parse(i.at) <= now).at(-1),
    vial = data.vials.find((v) => !v.retired) ?? data.vials.at(-1);
  const estimate = remaining(actual, now, c.halfLifeDays),
    used = vial ? usedVolume(vial, data.injections, now) : 0;
  const ratio = vial ? Math.max(0, 1 - used / vial.volume) : 0,
    clip = useId();
  const stats = c.status === "scenario" ? null : weightStats(weights, c, now);
  const samples = Array.from({ length: 85 }, (_, i) => {
    const at = now - ((84 - i) * DAY) / 4;
    return { at, mg: remaining(actual, at, c.halfLifeDays) ?? 0 };
  });
  const ceiling = Math.max(0.01, ...samples.map((s) => s.mg));
  const curve = samples
    .map((s, i) => `${i ? "L" : "M"}${(i / 84) * 280},${65 - (s.mg / ceiling) * 56}`)
    .join(" ");
  const doseMarks = Array.from({ length: 31 }, (_, i) => i);
  return (
    <section className="ij-course-hero" aria-label="Course at a glance">
      <div className="ij-prescription">
        <div className="ij-row">
          <span className="ij-eyebrow">
            {next && dayAt(next.at, c.timezone) === today ? "PLANNED TODAY" : "NEXT IN YOUR PLAN"}
          </span>
          <span className="ij-date-chip">
            {next ? dateLabel(next.at, c.timezone) : "No upcoming event"}
          </span>
        </div>
        <div className="ij-conversion">
          <div>
            <strong>{next ? number(next.units) : "—"}</strong>
            <span>syringe units</span>
          </div>
          <span className="ij-equals">=</span>
          <div>
            <strong>{number(next?.ml)}</strong>
            <span>mL liquid</span>
          </div>
          <span className="ij-equals">=</span>
          <div className="ij-active-dose">
            <strong>{number(next?.mg)}</strong>
            <span>mg medication</span>
          </div>
        </div>
        <svg
          viewBox="0 0 420 35"
          className="ij-syringe-scale"
          role="img"
          aria-label="Syringe conversion scale"
        >
          <line x1="0" x2="420" y1="3" y2="3" stroke="var(--hair-2)" />
          {doseMarks.map((i) => (
            <line
              key={i}
              x1={i * 14}
              x2={i * 14}
              y1="3"
              y2={i % 5 === 0 ? 21 : 12}
              stroke="var(--ink-2)"
              opacity={i % 5 === 0 ? 0.65 : 0.3}
            />
          ))}
          <text x="0" y="34" fill="var(--ink-2)" fontSize="9">
            0
          </text>
          <text x="420" y="34" fill="var(--ink-2)" fontSize="9" textAnchor="end">
            {c.syringeScale} UNITS / mL
          </text>
        </svg>
        <div className="ij-hero-foot">
          <span className="ij-status-dot" />
          <span>
            {last
              ? `Last recorded ${dateLabel(last.at, c.timezone)} · ${last.units} units`
              : "No actual injection recorded yet"}
          </span>
        </div>
      </div>
      <div className="ij-residual">
        <span className="ij-eyebrow">ESTIMATED IN YOUR BODY</span>
        <div className="ij-residual-number">
          {c.status === "scenario" ? "—" : number(estimate)}
          <span>mg</span>
        </div>
        <svg viewBox="0 0 280 75" aria-hidden="true">
          <path d={`${curve} L280,75 L0,75Z`} fill="var(--acc)" opacity=".09" />
          <path d={curve} stroke="var(--acc)" strokeWidth="2" fill="none" />
          <circle
            cx="280"
            cy={65 - ((samples.at(-1)?.mg ?? 0) / ceiling) * 56}
            r="3"
            fill="var(--acc)"
          />
        </svg>
        <div className="ij-hero-foot">
          <span>{c.halfLifeDays ?? "No"}-day half-life model</span>
          <span>21-day trace</span>
        </div>
      </div>
      <div className="ij-vial-card">
        <div>
          <span className="ij-eyebrow">{vial?.label.toUpperCase() ?? "VIAL"}</span>
          <div className="ij-vial-number">
            {vial ? number(ratio * 100, 0) : "—"}
            <span>%</span>
          </div>
          <span className="ij-muted">remaining</span>
          <p className="ij-vial-volume">
            {number(vial ? vial.volume - used : null)} <small>/ {number(vial?.volume)} mL</small>
          </p>
        </div>
        <svg
          viewBox="0 0 80 146"
          className="ij-vial-object"
          role="img"
          aria-label={`${number(ratio * 100, 0)} percent of vial remaining`}
        >
          <defs>
            <clipPath id={clip}>
              <path d="M22 33H58V44Q70 50 70 60V126Q70 138 58 138H22Q10 138 10 126V60Q10 50 22 44Z" />
            </clipPath>
          </defs>
          <rect x="20" y="8" width="40" height="16" rx="4" fill="var(--ink-2)" opacity=".4" />
          <rect x="23" y="24" width="34" height="11" fill="var(--ink-2)" opacity=".18" />
          <path
            d="M22 33H58V44Q70 50 70 60V126Q70 138 58 138H22Q10 138 10 126V60Q10 50 22 44Z"
            fill="var(--nest)"
            stroke="var(--hair-2)"
            strokeWidth="1.5"
          />
          <g clipPath={`url(#${clip})`}>
            <rect
              x="10"
              y={138 - ratio * 95}
              width="60"
              height={ratio * 95}
              fill="#9b8de5"
              opacity=".28"
            />
            <path
              d={`M10 ${138 - ratio * 95} Q25 ${132 - ratio * 95} 40 ${138 - ratio * 95} T70 ${138 - ratio * 95}`}
              stroke="#b4a3ef"
              fill="none"
              strokeWidth="2"
            />
            <rect x="16" y="57" width="3" height="60" rx="2" fill="white" opacity=".09" />
          </g>
          <path d="M55 65H65M59 80H65M55 95H65M59 110H65" stroke="#b4a3ef" opacity=".6" />
        </svg>
        <div className="ij-vial-meta">
          {number(used)} mL used ·{" "}
          {vial?.discardDate
            ? `discard ${dateLabel(`${vial.discardDate}T12:00:00Z`, "UTC")}`
            : "discard date not set"}
        </div>
      </div>
      <div className="ij-weight-ribbon">
        <span className="ij-eyebrow">WEIGHT / COURSE</span>
        <strong>
          {stats ? number(stats.last.kg * LB_PER_KG, 1) : "—"}
          <small>lb</small>
        </strong>
        <span className="ij-weight-change">
          {stats
            ? `${stats.change < 0 ? "↓" : "↑"} ${number(Math.abs(stats.change) * LB_PER_KG, 1)} lb`
            : "Awaiting first reading"}
        </span>
        <span className="ij-muted">
          {stats
            ? `${number(stats.percent, 1)}% since ${dateLabel(stats.first.at, c.timezone)}`
            : "Connected to your existing weight history"}
        </span>
        {stats && (
          <span className="ij-weight-range">
            <span>{number(stats.first.kg * LB_PER_KG, 1)}</span>
            <span className="ij-weight-track">
              <i />
            </span>
            <span>{number(stats.last.kg * LB_PER_KG, 1)}</span>
          </span>
        )}
      </div>
    </section>
  );
}
