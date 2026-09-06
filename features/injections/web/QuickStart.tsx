import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { trpc } from "@/lib/trpc";
import { courseInput, dayAt, type Settings } from "../model";
import { ErrorMessage, Field } from "./Forms";

export function QuickStart({
  defaults,
  onDone,
}: {
  defaults: Settings;
  onDone: (id: string) => void;
}) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [date, setDate] = useState(dayAt(Date.now(), timezone));
  const [concentration, setConcentration] = useState(defaults.concentration);
  const [scale, setScale] = useState(defaults.syringeScale);
  const [error, setError] = useState<unknown>(null);
  const save = trpc.injections.saveCourse.useMutation();
  return (
    <section className="ij-start">
      <span className="ij-eyebrow">{defaults.medication} · DOSE TRACKING</span>
      <h1>Log a dose. See your progress.</h1>
      <p>See the estimated amount in your body and your weight from the Weight tile.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const weekday = new Date(`${date}T12:00:00`).getDay();
            const config = courseInput.parse({
              ...defaults,
              concentration,
              syringeScale: scale,
              name: defaults.medication,
              startDate: date,
              endDate: null,
              timezone,
              status: "active",
              notes: "",
              stages: defaults.stages.map((s) => ({ ...s, weekdays: [weekday] })),
            });
            const result = await save.mutateAsync({ config });
            onDone(result.id);
          } catch (e) {
            setError(e);
          }
        }}
      >
        <h2>Confirm your setup once</h2>
        <div className="ij-form-grid">
          <Field label="Tracking start date">
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Concentration · mg/mL">
            <input
              type="number"
              required
              min="0.001"
              step="any"
              value={concentration}
              onChange={(e) => setConcentration(Number(e.target.value))}
            />
          </Field>
          <Field label="Syringe scale · units/mL">
            <input
              type="number"
              required
              min="0.001"
              step="any"
              value={scale}
              onChange={(e) => setScale(Number(e.target.value))}
            />
          </Field>
        </div>
        <p className="ij-muted">
          Saved forecast schedule:{" "}
          {defaults.stages
            .map((s) => `${s.units} units weekly in weeks ${s.startWeek}–${s.endWeek}`)
            .join("; ")}
          . Repeats on the weekday of your start date. You can edit this schedule in More.
        </p>
        <p className="ij-muted">
          This sets up tracking only. Next, enter the dose you actually took.
        </p>
        <ErrorMessage error={error} />
        <Button loading={save.isPending}>Confirm setup & log dose</Button>
      </form>
    </section>
  );
}
