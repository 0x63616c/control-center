import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_FILES,
  type EvidenceImageInput,
  EvidenceImageInputSchema,
} from "../../../contracts";

const EVIDENCE_MAX_SIDE = 2_048;
const EVIDENCE_MAX_PIXELS = 4_000_000;
const MAX_ENCODE_ATTEMPTS = 6;

export type EvidenceFileError =
  | "too_many_files"
  | "unsupported_type"
  | "file_too_large"
  | "invalid_dimensions"
  | "output_too_large"
  | "read_failed";

type ValidatedFiles =
  | { readonly ok: true; readonly files: readonly File[] }
  | { readonly ok: false; readonly error: EvidenceFileError };

type ReadEvidence =
  | { readonly ok: true; readonly evidence: readonly EvidenceImageInput[] }
  | { readonly ok: false; readonly error: EvidenceFileError };

type DecodedEvidenceImage<Source> = Readonly<{
  width: number;
  height: number;
  source: Source;
  close(): void;
}>;

export type EvidenceImageRuntime<Source> = Readonly<{
  decode(
    file: File,
    options: Readonly<{ imageOrientation: "from-image" }>,
  ): Promise<DecodedEvidenceImage<Source>>;
  encodePng(source: Source, width: number, height: number): Promise<Blob>;
}>;

class InvalidDimensionsError extends Error {}
class OutputTooLargeError extends Error {}

function isSupportedImageType(type: string): boolean {
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

function targetDimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new InvalidDimensionsError();
  }
  const scale = Math.min(
    1,
    EVIDENCE_MAX_SIDE / width,
    EVIDENCE_MAX_SIDE / height,
    Math.sqrt(EVIDENCE_MAX_PIXELS / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

async function pngDataUrl(blob: Blob): Promise<string> {
  return `data:image/png;base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
}

async function normalizeEvidenceFile<Source>(
  file: File,
  runtime: EvidenceImageRuntime<Source>,
): Promise<EvidenceImageInput> {
  const decoded = await runtime.decode(file, { imageOrientation: "from-image" });
  try {
    let dimensions = targetDimensions(decoded.width, decoded.height);
    for (let attempt = 0; attempt < MAX_ENCODE_ATTEMPTS; attempt += 1) {
      const blob = await runtime.encodePng(decoded.source, dimensions.width, dimensions.height);
      if (blob.type !== "image/png") throw new Error("canvas did not encode PNG");
      if (blob.size <= EVIDENCE_MAX_BYTES) {
        return EvidenceImageInputSchema.parse({
          mimeType: "image/png",
          dataUrl: await pngDataUrl(blob),
        });
      }
      const reduction = Math.min(0.85, Math.sqrt(EVIDENCE_MAX_BYTES / blob.size) * 0.95);
      const next = {
        width: Math.max(1, Math.floor(dimensions.width * reduction)),
        height: Math.max(1, Math.floor(dimensions.height * reduction)),
      };
      if (next.width === dimensions.width && next.height === dimensions.height) break;
      dimensions = next;
    }
    throw new OutputTooLargeError();
  } finally {
    decoded.close();
  }
}

const browserEvidenceRuntime: EvidenceImageRuntime<CanvasImageSource> = {
  async decode(file, options) {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file, options);
      return {
        width: bitmap.width,
        height: bitmap.height,
        source: bitmap,
        close: () => bitmap.close(),
      };
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        source: image,
        close: () => URL.revokeObjectURL(url),
      };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  },
  async encodePng(source, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("canvas unavailable");
    context.drawImage(source, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("canvas PNG encoding failed"))),
        "image/png",
      );
    });
  },
};

export async function readEvidenceFilesWithRuntime<Source>(
  files: readonly File[],
  runtime: EvidenceImageRuntime<Source>,
): Promise<ReadEvidence> {
  const validated = validateEvidenceFiles(files);
  if (!validated.ok) return validated;

  try {
    const evidence = await Promise.all(
      validated.files.map((file) => normalizeEvidenceFile(file, runtime)),
    );
    return { ok: true, evidence };
  } catch (error) {
    if (error instanceof InvalidDimensionsError) return { ok: false, error: "invalid_dimensions" };
    if (error instanceof OutputTooLargeError) return { ok: false, error: "output_too_large" };
    return { ok: false, error: "read_failed" };
  }
}

export function readEvidenceFiles(files: readonly File[]): Promise<ReadEvidence> {
  return readEvidenceFilesWithRuntime(files, browserEvidenceRuntime);
}
