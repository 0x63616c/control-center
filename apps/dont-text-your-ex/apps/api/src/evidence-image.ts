import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_PREFIX = "data:image/png;base64,";
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SIDE = 2048;
const MAX_PIXELS = 4_000_000;
const STRIPPABLE_ANCILLARY_CHUNKS = new Set([
  "cHRM",
  "eXIf",
  "gAMA",
  "iCCP",
  "iTXt",
  "pHYs",
  "sRGB",
  "tEXt",
  "tIME",
  "zTXt",
]);

declare const sanitizedEvidenceImage: unique symbol;

export type SanitizedEvidenceImage = {
  readonly mimeType: "image/png";
  readonly dataUrl: string;
  readonly [sanitizedEvidenceImage]: true;
};

type EvidenceImageInput = {
  readonly mimeType: string;
  readonly dataUrl: string;
};

function invalidImage(): never {
  throw new Error("invalid evidence image");
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + payload.length);
  result.writeUInt32BE(payload.length, 0);
  typeBytes.copy(result, 4);
  Buffer.from(payload).copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(payload)])), 8 + payload.length);
  return result;
}

function decodeCanonicalBase64(dataUrl: string): Buffer {
  if (!dataUrl.startsWith(PNG_PREFIX)) invalidImage();
  const encoded = dataUrl.slice(PNG_PREFIX.length);
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    invalidImage();
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length > MAX_SOURCE_BYTES || decoded.toString("base64") !== encoded) invalidImage();
  return decoded;
}

function channelsFor(colorType: number, bitDepth: number): number {
  if (bitDepth !== 8) invalidImage();
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  return invalidImage();
}

export function sanitizeEvidenceImage(input: EvidenceImageInput): SanitizedEvidenceImage {
  if (input.mimeType !== "image/png") invalidImage();
  const bytes = decodeCanonicalBase64(input.dataUrl);
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    invalidImage();
  }

  let offset = 8;
  let ihdr: Buffer | null = null;
  const idat: Buffer[] = [];
  let sawIdat = false;
  let endedIdat = false;
  let sawIend = false;

  while (offset < bytes.length) {
    if (sawIend || bytes.length - offset < 12) invalidImage();
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.length) invalidImage();
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) invalidImage();
    const reservedBit = typeBytes[2] ?? 0;
    if (reservedBit < 65 || reservedBit > 90) invalidImage();
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([typeBytes, payload])) !== expectedCrc) invalidImage();

    if (type === "IHDR") {
      if (ihdr || offset !== 8 || length !== 13) invalidImage();
      ihdr = Buffer.from(payload);
    } else if (type === "IDAT") {
      if (!ihdr || endedIdat || length === 0) invalidImage();
      sawIdat = true;
      idat.push(Buffer.from(payload));
    } else if (type === "IEND") {
      if (!ihdr || !sawIdat || length !== 0 || end !== bytes.length) invalidImage();
      sawIend = true;
    } else {
      if (sawIdat) endedIdat = true;
      // Reject unknown critical chunks. Ancillary chunks are deliberately omitted
      // when the sanitized PNG is rebuilt, removing metadata and polyglot payloads.
      if ((typeBytes[0] ?? 0) >= 65 && (typeBytes[0] ?? 0) <= 90) invalidImage();
      if (type === "acTL" || type === "fcTL" || type === "fdAT") invalidImage();
      if (!STRIPPABLE_ANCILLARY_CHUNKS.has(type)) invalidImage();
    }
    offset = end;
  }

  if (!ihdr || !sawIend) invalidImage();
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  if (
    width === 0 ||
    height === 0 ||
    width > MAX_SIDE ||
    height > MAX_SIDE ||
    width * height > MAX_PIXELS ||
    ihdr[10] !== 0 ||
    ihdr[11] !== 0 ||
    ihdr[12] !== 0
  ) {
    invalidImage();
  }
  const channels = channelsFor(ihdr[9] ?? -1, ihdr[8] ?? -1);
  const expectedInflatedBytes = height * (1 + width * channels);
  let filtered: Buffer;
  try {
    const compressed = Buffer.concat(idat);
    const inflated = inflateSync(compressed, {
      info: true,
      maxOutputLength: expectedInflatedBytes,
    }) as unknown as {
      readonly buffer: Buffer;
      readonly engine: { readonly bytesWritten: number };
    };
    if (inflated.engine.bytesWritten !== compressed.length) invalidImage();
    filtered = inflated.buffer;
  } catch {
    return invalidImage();
  }
  if (filtered.length !== expectedInflatedBytes) invalidImage();
  const rowLength = 1 + width * channels;
  for (let row = 0; row < height; row += 1) {
    if ((filtered[row * rowLength] ?? 5) > 4) invalidImage();
  }

  const canonical = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(filtered, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  if (canonical.length > MAX_SOURCE_BYTES) invalidImage();
  return {
    mimeType: "image/png",
    dataUrl: `${PNG_PREFIX}${canonical.toString("base64")}`,
  } as SanitizedEvidenceImage;
}
