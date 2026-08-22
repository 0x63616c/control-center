import type { BodyMetric } from "@features/weight/metrics";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { Button, Field, Modal, TextInput } from "@/components/ui";
import type { WeightReadingRow } from "./WeightReadingsView";

export type WeightCompositionKey = BodyMetric;

export interface WeightReadingComposition {
  key: WeightCompositionKey;
  label: string;
  unit: "lb" | "%";
  /** Display-unit value; null means this reading does not carry the metric. */
  value: number | null;
}

export interface WeightBodyMetricEdit {
  key: WeightCompositionKey;
  value: number | null;
}

type NonEmptyBodyMetricEdits = readonly [WeightBodyMetricEdit, ...WeightBodyMetricEdit[]];

export type WeightReadingEdit =
  | { weightLb: number; bodyMetrics?: NonEmptyBodyMetricEdits }
  | { weightLb?: never; bodyMetrics: NonEmptyBodyMetricEdits };

function bodyValuesOf(row: WeightReadingRow): Partial<Record<WeightCompositionKey, string>> {
  const values: Partial<Record<WeightCompositionKey, string>> = {};
  for (const metric of row.composition ?? []) {
    values[metric.key] = metric.value === null ? "" : metric.value.toFixed(1);
  }
  return values;
}

export function WeightReadingEditDialog({
  row,
  onSave,
  onClose,
}: {
  row: WeightReadingRow | null;
  onSave: (id: string, edit: WeightReadingEdit) => void | Promise<void>;
  onClose: () => void;
}) {
  const [weight, setWeight] = useState("");
  const [bodyValues, setBodyValues] = useState<Partial<Record<WeightCompositionKey, string>>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!row) return;
    setWeight(row.lb.toFixed(1));
    setBodyValues(bodyValuesOf(row));
    setError(undefined);
    setSaving(false);
  }, [row]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!row) return;
    const nextWeight = Number(weight);
    if (!Number.isFinite(nextWeight) || nextWeight <= 0 || nextWeight > 1_100) {
      setError("Weight must be between 0 and 1,100 lb.");
      return;
    }

    const bodyMetrics: WeightBodyMetricEdit[] = [];
    for (const metric of row.composition ?? []) {
      const text = (bodyValues[metric.key] ?? "").trim();
      const value = text === "" ? null : Number(text);
      const max = metric.unit === "%" ? 100 : 1_100;
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > max)) {
        setError(`${metric.label} must be between 0 and ${max}${metric.unit}.`);
        return;
      }
      const displayedOriginal = metric.value === null ? null : Number(metric.value.toFixed(1));
      if (value !== displayedOriginal) bodyMetrics.push({ key: metric.key, value });
    }

    const weightChanged = nextWeight !== Number(row.lb.toFixed(1));
    const [firstBodyMetric, ...remainingBodyMetrics] = bodyMetrics;
    if (!weightChanged && firstBodyMetric === undefined) {
      onClose();
      return;
    }
    let edit: WeightReadingEdit;
    if (firstBodyMetric === undefined) {
      edit = { weightLb: nextWeight };
    } else {
      const nonEmptyBodyMetrics: NonEmptyBodyMetricEdits = [
        firstBodyMetric,
        ...remainingBodyMetrics,
      ];
      edit = weightChanged
        ? { weightLb: nextWeight, bodyMetrics: nonEmptyBodyMetrics }
        : { bodyMetrics: nonEmptyBodyMetrics };
    }

    setSaving(true);
    setError(undefined);
    try {
      await onSave(row.id, edit);
      onClose();
    } catch {
      setError("Could not save this reading. Check the connection and try again.");
      setSaving(false);
    }
  };

  return (
    <Modal open={row !== null} onClose={onClose} title="Edit reading" width={560} maxHeight={820}>
      {row && (
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 14 }}>
            Change a value, or clear an optional body measurement. The rest of this reading stays
            intact.
          </p>
          <Field id="reading-weight" label="Weight">
            <TextInput
              id="reading-weight"
              label="Weight in pounds"
              value={weight}
              onChange={setWeight}
              disabled={saving}
            />
            <span style={{ marginLeft: 8, color: "var(--ink-3)", fontSize: 13 }}>lb</span>
          </Field>
          {(row.composition ?? []).map((metric) => {
            const id = `reading-${metric.key}`;
            return (
              <Field key={metric.key} id={id} label={metric.label} optional>
                <TextInput
                  id={id}
                  label={`${metric.label} in ${metric.unit === "%" ? "percent" : "pounds"}`}
                  value={bodyValues[metric.key] ?? ""}
                  onChange={(value) =>
                    setBodyValues((current) => ({ ...current, [metric.key]: value }))
                  }
                  disabled={saving}
                />
                <span style={{ marginLeft: 8, color: "var(--ink-3)", fontSize: 13 }}>
                  {metric.unit}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Clear ${metric.label}`}
                  onClick={() => setBodyValues((current) => ({ ...current, [metric.key]: "" }))}
                  disabled={(bodyValues[metric.key] ?? "") === "" || saving}
                  style={{
                    marginLeft: 8,
                    padding: "0 10px",
                    height: 36,
                    opacity: (bodyValues[metric.key] ?? "") === "" ? 0.4 : 1,
                  }}
                >
                  Clear
                </Button>
              </Field>
            );
          })}
          <div role={error ? "alert" : undefined} style={{ minHeight: 18, color: "var(--red)" }}>
            {error}
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
