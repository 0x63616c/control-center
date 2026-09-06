import { EvidenceImageInputSchema } from "../../../contracts";
import { type SanitizedEvidenceImage, sanitizeEvidenceImage } from "./evidence-image";

export function serializeEvidenceImageJson(value: SanitizedEvidenceImage): string {
  const sanitized = sanitizeEvidenceImage(value);
  return JSON.stringify({ mimeType: sanitized.mimeType, dataUrl: sanitized.dataUrl });
}

export function parseEvidenceImageJson(value: string): SanitizedEvidenceImage {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("invalid persisted report evidence");
  }
  const parsed = EvidenceImageInputSchema.safeParse(raw);
  if (!parsed.success) throw new Error("invalid persisted report evidence");
  try {
    return sanitizeEvidenceImage(parsed.data);
  } catch {
    throw new Error("invalid persisted report evidence");
  }
}
