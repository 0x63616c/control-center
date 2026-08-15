import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_FILES,
  type EvidenceImageInput,
  EvidenceImageInputSchema,
} from "../../../contracts";

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

function isSupportedImageType(type: string): type is EvidenceImageInput["mimeType"] {
  return type === "image/png" || type === "image/jpeg" || type === "image/webp";
}

export function validateEvidenceFiles(files: readonly File[]): ValidatedFiles {
  if (files.length > EVIDENCE_MAX_FILES) return { ok: false, error: "too_many_files" };
  for (const file of files) {
    if (!isSupportedImageType(file.type)) return { ok: false, error: "unsupported_type" };
    if (file.size > EVIDENCE_MAX_BYTES) return { ok: false, error: "file_too_large" };
  }
  return { ok: true, files };
}

function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read image"));
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("image reader returned non-text data"));
    };
    reader.readAsDataURL(file);
  });
}

export async function readEvidenceFiles(files: readonly File[]): Promise<ReadEvidence> {
  const validated = validateEvidenceFiles(files);
  if (!validated.ok) return validated;

  try {
    const evidence = await Promise.all(
      validated.files.map(async (file) =>
        EvidenceImageInputSchema.parse({
          mimeType: file.type,
          dataUrl: await readFileDataUrl(file),
        }),
      ),
    );
    return { ok: true, evidence };
  } catch {
    return { ok: false, error: "read_failed" };
  }
}
