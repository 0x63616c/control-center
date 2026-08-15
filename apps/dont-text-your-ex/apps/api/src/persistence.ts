import { type EvidenceThread, EvidenceThreadSchema } from "../../../contracts";

export function serializeEvidenceThreadJson(value: unknown): string {
  return JSON.stringify(EvidenceThreadSchema.parse(value));
}

export function parseEvidenceThreadJson(value: string): EvidenceThread {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("invalid persisted report evidence");
  }
  const parsed = EvidenceThreadSchema.safeParse(raw);
  if (!parsed.success) throw new Error("invalid persisted report evidence");
  return parsed.data;
}
