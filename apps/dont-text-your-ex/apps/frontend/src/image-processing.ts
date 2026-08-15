import { AVATAR_MAX_BYTES, AvatarPhotoDataUrlSchema } from "../../../contracts";

export const SOURCE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

export type ImageSourceError = "source_too_large" | "decode_failed";
type ImageProcessingError = ImageSourceError | "encode_failed";
export type ImageResult<T, E extends string = ImageProcessingError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export type LoadedImage = {
  readonly element: HTMLImageElement;
  readonly objectUrl: string;
};

export function validateImageSource(file: File): ImageResult<File, "source_too_large"> {
  return file.size <= SOURCE_IMAGE_MAX_BYTES
    ? { ok: true, value: file }
    : { ok: false, error: "source_too_large" };
}

export async function loadImageFile(
  file: File,
): Promise<ImageResult<LoadedImage, ImageSourceError>> {
  const valid = validateImageSource(file);
  if (!valid.ok) return valid;
  const objectUrl = URL.createObjectURL(file);
  const element = new Image();
  element.src = objectUrl;
  try {
    await element.decode();
    if (element.naturalWidth < 1 || element.naturalHeight < 1) throw new Error("empty image");
    return { ok: true, value: { element, objectUrl } };
  } catch {
    URL.revokeObjectURL(objectUrl);
    return { ok: false, error: "decode_failed" };
  }
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("image encoding failed"))),
      "image/jpeg",
      quality,
    );
  });
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("image output could not be read"));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("image output was not text"));
    reader.readAsDataURL(blob);
  });
}

async function boundedJpeg(canvas: HTMLCanvasElement, maxBytes: number): Promise<string> {
  let working = canvas;
  while (true) {
    for (const quality of [0.9, 0.82, 0.74, 0.66, 0.58, 0.5]) {
      const blob = await canvasBlob(working, quality);
      if (blob.size <= maxBytes) return blobDataUrl(blob);
    }
    if (Math.min(working.width, working.height) <= 512) break;
    const smaller = document.createElement("canvas");
    smaller.width = Math.max(512, Math.round(working.width * 0.8));
    smaller.height = Math.max(512, Math.round(working.height * 0.8));
    const context = smaller.getContext("2d");
    if (!context) throw new Error("canvas unavailable");
    context.drawImage(working, 0, 0, smaller.width, smaller.height);
    if (smaller.width === working.width && smaller.height === working.height) break;
    working = smaller;
  }
  throw new Error("image could not be made small enough");
}

export async function normalizeImageFile(
  file: File,
  maxBytes: number,
  maxDimension = 2048,
): Promise<ImageResult<string>> {
  const loaded = await loadImageFile(file);
  if (!loaded.ok) return loaded;
  try {
    const scale = Math.min(
      1,
      maxDimension /
        Math.max(loaded.value.element.naturalWidth, loaded.value.element.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(loaded.value.element.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(loaded.value.element.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas unavailable");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(loaded.value.element, 0, 0, canvas.width, canvas.height);
    return { ok: true, value: await boundedJpeg(canvas, maxBytes) };
  } catch {
    return { ok: false, error: "encode_failed" };
  } finally {
    URL.revokeObjectURL(loaded.value.objectUrl);
  }
}

export type CropTransform = {
  readonly zoom: number;
  readonly offset: { readonly x: number; readonly y: number };
  readonly viewportSize: number;
};

export async function cropProfileImage(
  image: HTMLImageElement,
  transform: CropTransform,
): Promise<ImageResult<string, "encode_failed">> {
  const { zoom, offset, viewportSize } = transform;
  const coverScale = Math.max(
    viewportSize / image.naturalWidth,
    viewportSize / image.naturalHeight,
  );
  const renderedScale = coverScale * zoom;
  const sourceSize = viewportSize / renderedScale;
  const centerX = image.naturalWidth / 2 - offset.x / renderedScale;
  const centerY = image.naturalHeight / 2 - offset.y / renderedScale;
  const sourceX = Math.max(0, Math.min(image.naturalWidth - sourceSize, centerX - sourceSize / 2));
  const sourceY = Math.max(0, Math.min(image.naturalHeight - sourceSize, centerY - sourceSize / 2));

  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas unavailable");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, 512, 512);
  context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, 512, 512);
  try {
    return {
      ok: true,
      value: AvatarPhotoDataUrlSchema.parse(await boundedJpeg(canvas, AVATAR_MAX_BYTES)),
    };
  } catch {
    return { ok: false, error: "encode_failed" };
  }
}
