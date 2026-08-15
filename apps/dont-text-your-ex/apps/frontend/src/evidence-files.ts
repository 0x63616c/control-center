import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_FILES,
  type EvidenceImageInput,
  EvidenceImageInputSchema,
} from "../../../contracts";
import { normalizeImageFile, SOURCE_IMAGE_MAX_BYTES } from "./image-processing";

export { SOURCE_IMAGE_MAX_BYTES } from "./image-processing";

export type EvidenceFileError =
  | "too_many_files"
  | "unsupported_type"
  | "file_too_large"
  | "read_failed";

type ValidatedFiles =
  | { readonly ok: true; readonly files: readonly File[] }
  | { readonly ok: false; readonly error: EvidenceFileError };

type ReadEvidence =
  | { readonly ok: true; readonly evidence: readonly EvidenceImageInput[] }
  | { readonly ok: false; readonly error: EvidenceFileError };

export function validateEvidenceFiles(files: readonly File[]): ValidatedFiles {
  if (files.length > EVIDENCE_MAX_FILES) return { ok: false, error: "too_many_files" };
  for (const file of files) {
    if (!file.type.startsWith("image/")) return { ok: false, error: "unsupported_type" };
    if (file.size > SOURCE_IMAGE_MAX_BYTES) return { ok: false, error: "file_too_large" };
  }
  return { ok: true, files };
}

export async function readEvidenceFiles(files: readonly File[]): Promise<ReadEvidence> {
  const validated = validateEvidenceFiles(files);
  if (!validated.ok) return validated;

  try {
    const evidence = await Promise.all(
      validated.files.map(async (file) =>
        EvidenceImageInputSchema.parse({
          mimeType: "image/jpeg",
          dataUrl: await normalizeImageFile(file, EVIDENCE_MAX_BYTES),
        }),
      ),
    );
    return { ok: true, evidence };
  } catch {
    return { ok: false, error: "read_failed" };
  }
}
