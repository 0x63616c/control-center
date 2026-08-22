import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { Button, Field, Modal, TextInput } from "@/components/ui";
import type { WeightReadingRow } from "./WeightReadingsView";

export type WeightCompositionKey =
  | "fat_ratio_percent"
  | "fat_mass_kg"
  | "muscle_mass_kg"
  | "hydration_kg"
  | "bone_mass_kg"
  | "fat_free_mass_kg";

export interface WeightReadingComposition {
  key: WeightCompositionKey;
  label: string;
  unit: "lb" | "%";
  /** Display-unit value; null means this reading does not carry the metric. */
  value: number | null;
}

export interface WeightReadingEdit {
  weightLb?: number;
  bodyMetrics?: Partial<Record<WeightCompositionKey, number | null>>;
}

function compositionValue(row: WeightReadingRow, key: WeightCompositionKey): string {
  const value = row.composition?.find((metric) => metric.key === key)?.value;
  return value === null || value === undefined ? "" : value.toFixed(1);
}

export function WeightReadingEditDialog({
  row,
  onSave,
  onClose,
}: {
  row: WeightReadingRow | null;
  onSave: (id: string, edit: WeightReadingEdit) => void;
  onClose: () => void;
}) {
  const [weight, setWeight] = useState("");
  const [bodyValues, setBodyValues] = useState<Record<WeightCompositionKey, string>>({
    fat_ratio_percent: "",
    fat_mass_kg: "",
    muscle_mass_kg: "",
    hydration_kg: "",
    bone_mass_kg: "",
    fat_free_mass_kg: "",
  });
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!row) return;
    setWeight(row.lb.toFixed(1));
    setBodyValues({
      fat_ratio_percent: compositionValue(row, "fat_ratio_percent"),
      fat_mass_kg: compositionValue(row, "fat_mass_kg"),
      muscle_mass_kg: compositionValue(row, "muscle_mass_kg"),
      hydration_kg: compositionValue(row, "hydration_kg"),
      bone_mass_kg: compositionValue(row, "bone_mass_kg"),
      fat_free_mass_kg: compositionValue(row, "fat_free_mass_kg"),
    });
    setError(undefined);
  }, [row]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!row) return;
    const nextWeight = Number(weight);
    if (!Number.isFinite(nextWeight) || nextWeight <= 0 || nextWeight > 1_100) {
      setError("Weight must be between 0 and 1,100 lb.");
      return;
    }

    const bodyMetrics: Partial<Record<WeightCompositionKey, number | null>> = {};
    for (const metric of row.composition ?? []) {
      const text = bodyValues[metric.key].trim();
      const value = text === "" ? null : Number(text);
      const max = metric.unit === "%" ? 100 : 1_100;
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > max)) {
        setError(`${metric.label} must be between 0 and ${max}${metric.unit}.`);
        return;
      }
      const displayedOriginal = metric.value === null ? null : Number(metric.value.toFixed(1));
      if (value !== displayedOriginal) bodyMetrics[metric.key] = value;
    }

    const edit: WeightReadingEdit = {};
    if (nextWeight !== Number(row.lb.toFixed(1))) edit.weightLb = nextWeight;
    if (Object.keys(bodyMetrics).length > 0) edit.bodyMetrics = bodyMetrics;
    if (edit.weightLb === undefined && edit.bodyMetrics === undefined) {
      onClose();
      return;
    }
    onSave(row.id, edit);
    onClose();
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
                  value={bodyValues[metric.key]}
                  onChange={(value) =>
                    setBodyValues((current) => ({ ...current, [metric.key]: value }))
                  }
                />
                <span style={{ marginLeft: 8, color: "var(--ink-3)", fontSize: 13 }}>
                  {metric.unit}
                </span>
                <button
                  type="button"
                  aria-label={`Clear ${metric.label}`}
                  onClick={() => setBodyValues((current) => ({ ...current, [metric.key]: "" }))}
                  disabled={bodyValues[metric.key] === ""}
                  style={{
                    marginLeft: 8,
                    padding: "0 10px",
                    height: 36,
                    borderRadius: 10,
                    border: "1px solid var(--hair)",
                    background: "var(--nest)",
                    color: "var(--ink-2)",
                    opacity: bodyValues[metric.key] === "" ? 0.4 : 1,
                  }}
                >
                  Clear
                </button>
              </Field>
            );
          })}
          <div role={error ? "alert" : undefined} style={{ minHeight: 18, color: "var(--red)" }}>
            {error}
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Save changes</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
