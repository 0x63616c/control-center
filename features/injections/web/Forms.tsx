import { cloneElement, type ReactElement, type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { trpc } from "@/lib/trpc";
import {
  type Course,
  type CourseConfig,
  convert,
  courseInput,
  dayAt,
  plannedInjections,
  type RecordSet,
  type Settings,
  scenario,
  type Vial,
  type Weight,
} from "../model";
import { number } from "./Timeline";

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <div className="ij-field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}
export function ErrorMessage({ error }: { error: unknown }) {
  return error ? (
    <p className="ij-error" role="alert">
      {error instanceof Error ? error.message : String(error)}
    </p>
  ) : null;
}
export function FormShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <section className="ij-form-page">
      <div className="ij-row">
        <h2>{title}</h2>
        <Button variant="ghost" type="button" onClick={onClose}>
          Back to timeline
        </Button>
      </div>
      {children}
    </section>
  );
}

export function CourseForm({
  course,
  defaults,
  onDone,
}: {
  course?: Course;
  defaults: Settings;
  onDone: (id?: string) => void;
}) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [config, setConfig] = useState<CourseConfig>(
    course ?? {
      ...defaults,
      name: `${defaults.medication} course`,
      startDate: dayAt(Date.now(), tz),
      endDate: null,
      timezone: tz,
      status: "active",
      notes: "",
    },
  );
  const [error, setError] = useState<unknown>(null);
  const [remember, setRemember] = useState(true);
  const save = trpc.injections.saveCourse.useMutation();
  const saveSettings = trpc.injections.saveSettings.useMutation();
  const change = <K extends keyof CourseConfig>(key: K, value: CourseConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }));
  return (
    <FormShell
      title={course ? "Edit course & schedule" : "Start a course"}
      onClose={() => onDone()}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            const parsed = courseInput.parse(config);
            const saved = await save.mutateAsync({ id: course?.id, config: parsed });
            if (remember) await saveSettings.mutateAsync(parsed);
            onDone(saved.id);
          } catch (e) {
            setError(e);
          }
        }}
      >
        <p className="ij-muted">
          Enter your existing regimen. Planned injections and recorded injections stay separate.
        </p>
        {!course && (
          <div className="ij-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                setConfig({
                  ...scenario("2026", config.startDate, config.timezone),
                  status: "active",
                  name: "Semaglutide course",
                })
              }
            >
              Use 2026 schedule
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                setConfig({
                  ...scenario("2024", config.startDate, config.timezone),
                  status: "completed",
                  name: "Historical course",
                })
              }
            >
              Use 2024 schedule
            </Button>
          </div>
        )}
        <div className="ij-form-grid">
          <Field label="Course name">
            <input required value={config.name} onChange={(e) => change("name", e.target.value)} />
          </Field>
          <Field label="Medication">
            <input
              required
              value={config.medication}
              onChange={(e) => {
                change("medication", e.target.value);
                if (e.target.value.toLowerCase() !== "semaglutide") change("halfLifeDays", null);
              }}
            />
          </Field>
          <Field label="Concentration · mg/mL">
            <input
              required
              type="number"
              min="0.001"
              step="any"
              value={config.concentration}
              onChange={(e) => change("concentration", Number(e.target.value))}
            />
          </Field>
          <Field label="Syringe scale · units/mL">
            <input
              required
              type="number"
              min="0.001"
              step="any"
              value={config.syringeScale}
              onChange={(e) => change("syringeScale", Number(e.target.value))}
            />
          </Field>
          <Field label="Supplied vial volume · mL">
            <input
              required
              type="number"
              min="0.001"
              step="any"
              value={config.vialVolume}
              onChange={(e) => change("vialVolume", Number(e.target.value))}
            />
          </Field>
          <Field label="Half-life · days (optional)">
            <input
              type="number"
              min="0.001"
              step="any"
              value={config.halfLifeDays ?? ""}
              onChange={(e) =>
                change("halfLifeDays", e.target.value ? Number(e.target.value) : null)
              }
            />
          </Field>
          <Field label="Start date">
            <input
              required
              type="date"
              value={config.startDate}
              onChange={(e) => change("startDate", e.target.value)}
            />
          </Field>
          <Field label="End date (optional)">
            <input
              type="date"
              value={config.endDate ?? ""}
              onChange={(e) => change("endDate", e.target.value || null)}
            />
          </Field>
          <Field label="Schedule time zone">
            <input
              required
              value={config.timezone}
              onChange={(e) => change("timezone", e.target.value)}
            />
          </Field>
          <Field label="Status">
            <select
              value={config.status}
              onChange={(e) => {
                const parsed = courseInput.shape.status.safeParse(e.target.value);
                if (parsed.success) change("status", parsed.data);
              }}
            >
              <option value="active">Active</option>
              <option value="completed">Completed</option>
              <option value="scenario">Scenario only</option>
            </select>
          </Field>
        </div>
        <h3>Planned schedule</h3>
        <p className="ij-muted">
          Week 1 begins on the start date. Multiple weekdays produce independent planned events.
        </p>
        {config.stages.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Controlled stage inputs have no local state; removal remounts the stage list.
          <fieldset className="ij-stage" key={`${i}-${config.stages.length}`}>
            <legend>Stage {i + 1}</legend>
            <div className="ij-form-grid">
              <Field label="From week">
                <input
                  type="number"
                  min="1"
                  max="520"
                  required
                  value={s.startWeek}
                  onChange={(e) =>
                    change(
                      "stages",
                      config.stages.map((a, n) =>
                        n === i ? { ...a, startWeek: Number(e.target.value) } : a,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="Through week">
                <input
                  type="number"
                  min={s.startWeek}
                  max="520"
                  required
                  value={s.endWeek}
                  onChange={(e) =>
                    change(
                      "stages",
                      config.stages.map((a, n) =>
                        n === i ? { ...a, endWeek: Number(e.target.value) } : a,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="Syringe units per event">
                <input
                  type="number"
                  min="0.001"
                  step="any"
                  required
                  value={s.units}
                  onChange={(e) =>
                    change(
                      "stages",
                      config.stages.map((a, n) =>
                        n === i ? { ...a, units: Number(e.target.value) } : a,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="Preferred time">
                <input
                  required
                  type="time"
                  value={s.time}
                  onChange={(e) =>
                    change(
                      "stages",
                      config.stages.map((a, n) => (n === i ? { ...a, time: e.target.value } : a)),
                    )
                  }
                />
              </Field>
            </div>
            <div className="ij-weekdays">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, d) => (
                <label key={day}>
                  <input
                    type="checkbox"
                    checked={s.weekdays.includes(d)}
                    onChange={(e) =>
                      change(
                        "stages",
                        config.stages.map((a, n) =>
                          n === i
                            ? {
                                ...a,
                                weekdays: e.target.checked
                                  ? [...a.weekdays, d]
                                  : a.weekdays.filter((v) => v !== d),
                              }
                            : a,
                        ),
                      )
                    }
                  />
                  {day}
                </label>
              ))}
            </div>
            <div className="ij-row">
              <span>
                {number(convert(s.units, config).ml)} mL · {number(convert(s.units, config).mg)} mg
                per event
              </span>
              <Button
                type="button"
                variant="ghost"
                disabled={config.stages.length === 1}
                onClick={() =>
                  change(
                    "stages",
                    config.stages.filter((_, n) => n !== i),
                  )
                }
              >
                Remove stage
              </Button>
            </div>
          </fieldset>
        ))}
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            const start = (config.stages.at(-1)?.endWeek ?? 0) + 1;
            change("stages", [
              ...config.stages,
              { startWeek: start, endWeek: start + 3, units: 3, weekdays: [5], time: "20:00" },
            ]);
          }}
        >
          Add stage
        </Button>
        <div className="ij-form-grid">
          <Field label="Primary display unit">
            <select
              value={config.primaryUnit}
              onChange={(e) => {
                const p = courseInput.shape.primaryUnit.safeParse(e.target.value);
                if (p.success) change("primaryUnit", p.data);
              }}
            >
              {["units", "mg", "mL"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
          <Field label="Default graph range">
            <select
              value={config.range}
              onChange={(e) => {
                const p = courseInput.shape.range.safeParse(e.target.value);
                if (p.success) change("range", p.data);
              }}
            >
              {["4W", "12W", "Course", "All"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Optional check-in fields · comma separated">
          <input
            value={config.checkInFields.join(", ")}
            onChange={(e) =>
              change(
                "checkInFields",
                e.target.value.split(",").map((v) => v.trim()),
              )
            }
          />
        </Field>
        <Field label="Course notes">
          <textarea
            rows={3}
            value={config.notes}
            onChange={(e) => change("notes", e.target.value)}
          />
        </Field>
        <label className="ij-check">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Remember these defaults for future courses
        </label>
        <ErrorMessage error={error} />
        <Button loading={save.isPending || saveSettings.isPending}>Save course & schedule</Button>
      </form>
    </FormShell>
  );
}

function localInput(at: string): string {
  const d = new Date(at);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function InjectionForm({
  data,
  id,
  onDone,
}: {
  data: RecordSet;
  id?: string;
  onDone: () => void;
}) {
  const old = data.injections.find((i) => i.id === id),
    plan = plannedInjections(data.course),
    today = dayAt(Date.now(), data.course.timezone);
  const todayPlan = plan.find(
    (p) =>
      dayAt(p.at, data.course.timezone) === today &&
      !data.injections.some((i) => i.plannedAt && Date.parse(i.plannedAt) === Date.parse(p.at)),
  );
  const last = data.injections.at(-1);
  const [vialId, setVialId] = useState(
    old?.vialId ??
      data.vials.find((v) => !v.retired && v.id === last?.vialId)?.id ??
      data.vials.find((v) => !v.retired)?.id ??
      "",
  );
  const [units, setUnits] = useState(
    old?.units ?? todayPlan?.units ?? last?.units ?? data.course.stages[0]?.units ?? 3,
  );
  const [at, setAt] = useState(localInput(old?.at ?? new Date().toISOString()));
  const [notes, setNotes] = useState(old?.notes ?? "");
  const [plannedAt, setPlannedAt] = useState(old?.plannedAt ?? todayPlan?.at ?? "");
  const [error, setError] = useState<unknown>(null),
    [confirm, setConfirm] = useState(false);
  const save = trpc.injections.saveInjection.useMutation(),
    remove = trpc.injections.deleteInjection.useMutation();
  const vial = data.vials.find((v) => v.id === vialId),
    dose = vial ? convert(units, vial) : null;
  return (
    <FormShell title={old ? "Edit actual injection" : "Log injection"} onClose={onDone}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await save.mutateAsync({
              id,
              courseId: data.course.id,
              vialId,
              units,
              at: new Date(at).toISOString(),
              notes,
              plannedAt: plannedAt || null,
            });
            onDone();
          } catch (e) {
            setError(e);
          }
        }}
      >
        <p className="ij-muted">
          Record what you actually took.{" "}
          {todayPlan
            ? `Today's plan: ${todayPlan.units} units.`
            : "No plan is changed by this entry."}
        </p>
        <div className="ij-form-grid">
          <Field label="Actual syringe units">
            <input
              required
              type="number"
              min="0.001"
              step="any"
              value={units}
              onChange={(e) => setUnits(Number(e.target.value))}
            />
          </Field>
          <Field label={`Date & time · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}>
            <input
              required
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </Field>
          <Field label="Vial">
            <select required value={vialId} onChange={(e) => setVialId(e.target.value)}>
              {data.vials.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} · {v.concentration} mg/mL{v.retired ? " · retired" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Link to a planned event (optional)">
            <select value={plannedAt} onChange={(e) => setPlannedAt(e.target.value)}>
              <option value="">Independent actual injection</option>
              {plan.map((p) => (
                <option key={p.at} value={p.at}>
                  {new Date(p.at).toLocaleString("en-US", { timeZone: data.course.timezone })} ·{" "}
                  {p.units} units
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="ij-dose-preview">
          {number(units)} units{" "}
          <span>
            = {number(dose?.ml)} mL = {number(dose?.mg)} mg
          </span>
        </div>
        {vial?.discardDate && (
          <p className="ij-muted">
            Vial discard / beyond-use date: {vial.discardDate}. Physical remaining volume is
            separate.
          </p>
        )}
        <Field label="Optional injection note">
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <ErrorMessage error={error} />
        <Button loading={save.isPending || remove.isPending} disabled={!vial}>
          Save actual injection
        </Button>
        {old && (
          <div className="ij-actions">
            {confirm ? (
              <>
                <span>Remove this injection from history and calculations?</span>
                <Button
                  type="button"
                  variant="ghost"
                  loading={remove.isPending}
                  onClick={async () => {
                    try {
                      await remove.mutateAsync({ id: old.id, courseId: data.course.id });
                      onDone();
                    } catch (e) {
                      setError(e);
                    }
                  }}
                >
                  Confirm removal
                </Button>
                <Button type="button" variant="ghost" onClick={() => setConfirm(false)}>
                  Keep injection
                </Button>
              </>
            ) : (
              <Button type="button" variant="ghost" onClick={() => setConfirm(true)}>
                Remove injection
              </Button>
            )}
          </div>
        )}
      </form>
    </FormShell>
  );
}

export function VialForm({
  data,
  vial,
  onDone,
}: {
  data: RecordSet;
  vial?: Vial;
  onDone: () => void;
}) {
  const [value, setValue] = useState(
    vial ?? {
      courseId: data.course.id,
      label: `Vial ${data.vials.length + 1}`,
      volume: data.course.vialVolume,
      concentration: data.course.concentration,
      syringeScale: data.course.syringeScale,
      receivedDate: null,
      openedDate: null,
      discardDate: null,
      retired: false,
    },
  );
  const save = trpc.injections.saveVial.useMutation();
  const [error, setError] = useState<unknown>(null);
  return (
    <FormShell title={vial ? "Edit vial" : "Add vial"} onClose={onDone}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await save.mutateAsync(value);
            onDone();
          } catch (e) {
            setError(e);
          }
        }}
      >
        <div className="ij-form-grid">
          <Field label="Vial label">
            <input
              required
              value={value.label}
              onChange={(e) => setValue({ ...value, label: e.target.value })}
            />
          </Field>
          {(
            [
              { key: "volume", label: "Supplied volume · mL" },
              { key: "concentration", label: "Concentration · mg/mL" },
              { key: "syringeScale", label: "Syringe scale · units/mL" },
            ] as const
          ).map((f) => (
            <Field key={f.key} label={f.label}>
              <input
                required
                type="number"
                step="any"
                min="0.001"
                value={value[f.key]}
                onChange={(e) => setValue({ ...value, [f.key]: Number(e.target.value) })}
              />
            </Field>
          ))}
          {(
            [
              { key: "receivedDate", label: "Received date" },
              { key: "openedDate", label: "Opened date" },
              { key: "discardDate", label: "Discard / beyond-use date" },
            ] as const
          ).map((f) => (
            <Field key={f.key} label={f.label}>
              <input
                type="date"
                value={value[f.key] ?? ""}
                onChange={(e) => setValue({ ...value, [f.key]: e.target.value || null })}
              />
            </Field>
          ))}
        </div>
        <label className="ij-check">
          <input
            type="checkbox"
            checked={value.retired}
            onChange={(e) => setValue({ ...value, retired: e.target.checked })}
          />
          This vial is retired / discarded
        </label>
        <p className="ij-muted">
          Discarding a vial does not end the course or change its recorded usage.
        </p>
        <ErrorMessage error={error} />
        <Button loading={save.isPending}>Save vial</Button>
      </form>
    </FormShell>
  );
}

export function CheckInForm({
  data,
  date,
  weights,
  onDone,
}: {
  data: RecordSet;
  date: string;
  weights: Weight[];
  onDone: () => void;
}) {
  const old = data.checkIns.find((e) => e.date === date);
  const [values, setValues] = useState(old?.values ?? {});
  const [notes, setNotes] = useState(old?.notes ?? "");
  const [weightId, setWeightId] = useState(old?.weightId ?? "");
  const save = trpc.injections.saveCheckIn.useMutation();
  const [error, setError] = useState<unknown>(null);
  return (
    <FormShell title={`Daily check-in · ${date}`} onClose={onDone}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await save.mutateAsync({
              courseId: data.course.id,
              date,
              values,
              notes,
              weightId: weightId || null,
            });
            onDone();
          } catch (e) {
            setError(e);
          }
        }}
      >
        <p className="ij-muted">
          Everything is optional. 0 = none / very low, 4 = very high. Choose your fields in course
          settings.
        </p>
        <div className="ij-form-grid">
          {[...new Set([...data.course.checkInFields, ...Object.keys(values)])].map((field) => (
            <Field key={field} label={field}>
              <select
                value={values[field] ?? ""}
                onChange={(e) => {
                  const next = { ...values };
                  if (e.target.value === "") delete next[field];
                  else next[field] = Number(e.target.value);
                  setValues(next);
                }}
              >
                <option value="">Not recorded</option>
                {[0, 1, 2, 3, 4].map((v) => (
                  <option key={v} value={v}>
                    {v}
                    {v === 0 ? " · none / very low" : v === 4 ? " · very high" : ""}
                  </option>
                ))}
              </select>
            </Field>
          ))}
        </div>
        <Field label="How are you feeling? Notes">
          <textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <Field label="Attach this note to a weight reading (optional)">
          <select value={weightId} onChange={(e) => setWeightId(e.target.value)}>
            <option value="">Daily note only</option>
            {weights
              .filter((w) => dayAt(w.at, data.course.timezone) === date)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {new Date(w.at).toLocaleTimeString()} · {number(w.kg * 2.2046226218, 1)} lb
                </option>
              ))}
          </select>
        </Field>
        <ErrorMessage error={error} />
        <Button loading={save.isPending}>Save check-in</Button>
      </form>
    </FormShell>
  );
}
