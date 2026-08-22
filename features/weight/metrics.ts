export const BODY_METRIC_KEYS = [
  "fat_ratio_percent",
  "fat_mass_kg",
  "muscle_mass_kg",
  "hydration_kg",
  "bone_mass_kg",
  "fat_free_mass_kg",
] as const;

export type BodyMetric = (typeof BODY_METRIC_KEYS)[number];

export const WEIGHT_METRICS = {
  weight_kg: { label: "Weight", unit: "kg" },
  fat_ratio_percent: { label: "Fat", unit: "percent" },
  fat_mass_kg: { label: "Fat mass", unit: "kg" },
  muscle_mass_kg: { label: "Muscle", unit: "kg" },
  hydration_kg: { label: "Hydration", unit: "kg" },
  bone_mass_kg: { label: "Bone", unit: "kg" },
  fat_free_mass_kg: { label: "Fat-free", unit: "kg" },
} as const satisfies Record<"weight_kg" | BodyMetric, { label: string; unit: "kg" | "percent" }>;

export type WeightMetric = keyof typeof WEIGHT_METRICS;
