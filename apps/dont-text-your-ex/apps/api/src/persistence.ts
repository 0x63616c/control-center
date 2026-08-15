import { type EvidenceImageInput, EvidenceImageInputSchema } from "../../../contracts";

export function serializeEvidenceImageJson(value: unknown): string {
  return JSON.stringify(EvidenceImageInputSchema.parse(value));
}

export function parseEvidenceImageJson(value: string): EvidenceImageInput {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("invalid persisted report evidence");
  }
  const parsed = EvidenceImageInputSchema.safeParse(raw);
  if (!parsed.success) throw new Error("invalid persisted report evidence");
  return parsed.data;
}
