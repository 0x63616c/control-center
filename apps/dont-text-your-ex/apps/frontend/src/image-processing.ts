import { AVATAR_MAX_BYTES, AvatarPhotoDataUrlSchema } from "../../../contracts";

export const SOURCE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

export type LoadedImage = {
  readonly element: HTMLImageElement;
  readonly objectUrl: string;
};

export async function loadImageFile(file: File): Promise<LoadedImage> {
  const objectUrl = URL.createObjectURL(file);
  const element = new Image();
  element.src = objectUrl;
  try {
    await element.decode();
    if (element.naturalWidth < 1 || element.naturalHeight < 1) throw new Error("empty image");
    return { element, objectUrl };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
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
): Promise<string> {
  const loaded = await loadImageFile(file);
  try {
    const scale = Math.min(
      1,
      maxDimension / Math.max(loaded.element.naturalWidth, loaded.element.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(loaded.element.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(loaded.element.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas unavailable");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(loaded.element, 0, 0, canvas.width, canvas.height);
    return await boundedJpeg(canvas, maxBytes);
  } finally {
    URL.revokeObjectURL(loaded.objectUrl);
  }
}

export async function cropProfileImage(
  image: HTMLImageElement,
  zoom: number,
  offsetX: number,
  offsetY: number,
  viewportSize: number,
): Promise<string> {
  const coverScale = Math.max(
    viewportSize / image.naturalWidth,
    viewportSize / image.naturalHeight,
  );
  const renderedScale = coverScale * zoom;
  const sourceSize = viewportSize / renderedScale;
  const centerX = image.naturalWidth / 2 - offsetX / renderedScale;
  const centerY = image.naturalHeight / 2 - offsetY / renderedScale;
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
  return AvatarPhotoDataUrlSchema.parse(await boundedJpeg(canvas, AVATAR_MAX_BYTES));
}
