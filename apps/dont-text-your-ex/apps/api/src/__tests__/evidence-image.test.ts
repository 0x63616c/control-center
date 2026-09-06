import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { sanitizeEvidenceImage } from "../evidence-image";

const TRANSPARENT_ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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

function grayscalePng(width: number, height: number, interlace = 0): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  ihdr[12] = interlace;
  const filtered = Buffer.alloc(height * (width + 1));
  return `data:image/png;base64,${Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(filtered)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64")}`;
}

function chunkTypes(dataUrl: string): string[] {
  const bytes = Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
  const result: string[] = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    result.push(bytes.subarray(offset + 4, offset + 8).toString("ascii"));
    offset += length + 12;
  }
  return result;
}

function withChunkBeforeIend(type: string, payload: string): string {
  const source = Buffer.from(TRANSPARENT_ONE_PIXEL_PNG.split(",")[1] ?? "", "base64");
  const typeBytes = Buffer.from(type, "ascii");
  const payloadBytes = Buffer.from(payload, "utf8");
  const chunk = Buffer.alloc(12 + payloadBytes.length);
  chunk.writeUInt32BE(payloadBytes.length, 0);
  typeBytes.copy(chunk, 4);
  payloadBytes.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, payloadBytes])), 8 + payloadBytes.length);
  return `data:image/png;base64,${Buffer.concat([
    source.subarray(0, -12),
    chunk,
    source.subarray(-12),
  ]).toString("base64")}`;
}

describe("evidence image sanitizer", () => {
  it("accepts and canonically rebuilds a valid bounded PNG", () => {
    const sanitized = sanitizeEvidenceImage({
      mimeType: "image/png",
      dataUrl: TRANSPARENT_ONE_PIXEL_PNG,
    });

    expect(sanitized.mimeType).toBe("image/png");
    expect(sanitizeEvidenceImage(sanitized)).toEqual(sanitized);
  });

  it("accepts browser-style RGBA8 but rejects bytes hidden after its zlib stream", () => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const hiddenMarker = Buffer.from("hidden-after-zlib");
    const compressed = deflateSync(Buffer.from([0, 1, 2, 3, 4]));
    const cleanInput = `data:image/png;base64,${Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", compressed),
      pngChunk("IEND", Buffer.alloc(0)),
    ]).toString("base64")}`;
    const input = `data:image/png;base64,${Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", Buffer.concat([compressed, hiddenMarker])),
      pngChunk("IEND", Buffer.alloc(0)),
    ]).toString("base64")}`;

    expect(() =>
      sanitizeEvidenceImage({ mimeType: "image/png", dataUrl: cleanInput }),
    ).not.toThrow();
    expect(() => sanitizeEvidenceImage({ mimeType: "image/png", dataUrl: input })).toThrow(
      "invalid evidence image",
    );
  });

  it("rejects a PNG chunk with a lowercase reserved bit", () => {
    expect(() =>
      sanitizeEvidenceImage({
        mimeType: "image/png",
        dataUrl: withChunkBeforeIend("texT", "hidden metadata"),
      }),
    ).toThrow("invalid evidence image");
  });

  it("rejects pixel-affecting ancillary chunks instead of changing their meaning", () => {
    expect(() =>
      sanitizeEvidenceImage({
        mimeType: "image/png",
        dataUrl: withChunkBeforeIend("tRNS", "\u0000\u0000"),
      }),
    ).toThrow("invalid evidence image");
  });

  it("removes metadata and rebuilds only canonical image chunks", () => {
    const sanitized = sanitizeEvidenceImage({
      mimeType: "image/png",
      dataUrl: withChunkBeforeIend("tEXt", "private marker"),
    });

    expect(chunkTypes(sanitized.dataUrl)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(
      Buffer.from(sanitized.dataUrl.split(",")[1] ?? "", "base64").includes("private marker"),
    ).toBe(false);
  });

  it.each([
    ["JPEG direct upload", { mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,/9j/AA==" }],
    [
      "PNG with trailing polyglot bytes",
      {
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${Buffer.concat([
          Buffer.from(TRANSPARENT_ONE_PIXEL_PNG.split(",")[1] ?? "", "base64"),
          Buffer.from("PK\u0003\u0004"),
        ]).toString("base64")}`,
      },
    ],
    [
      "unknown critical chunk",
      { mimeType: "image/png", dataUrl: withChunkBeforeIend("ABCD", "critical") },
    ],
    ["animated PNG", { mimeType: "image/png", dataUrl: withChunkBeforeIend("acTL", "apng") }],
  ])("rejects %s", (_name, input) => {
    expect(() => sanitizeEvidenceImage(input)).toThrow("invalid evidence image");
  });

  it("rejects bad CRCs, truncated streams, decompression bombs, and invalid row filters", () => {
    const source = Buffer.from(TRANSPARENT_ONE_PIXEL_PNG.split(",")[1] ?? "", "base64");
    const badCrc = Buffer.from(source);
    badCrc[20] = (badCrc[20] ?? 0) ^ 1;

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 0;
    const makeWithFiltered = (filtered: Buffer) =>
      `data:image/png;base64,${Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", deflateSync(filtered)),
        pngChunk("IEND", Buffer.alloc(0)),
      ]).toString("base64")}`;

    for (const dataUrl of [
      `data:image/png;base64,${badCrc.toString("base64")}`,
      `data:image/png;base64,${source.subarray(0, -1).toString("base64")}`,
      makeWithFiltered(Buffer.alloc(10_000)),
      makeWithFiltered(Buffer.from([5, 0])),
    ]) {
      expect(() => sanitizeEvidenceImage({ mimeType: "image/png", dataUrl })).toThrow(
        "invalid evidence image",
      );
    }
  });

  it("rejects duplicate/non-contiguous critical chunks and interlaced input", () => {
    const source = Buffer.from(TRANSPARENT_ONE_PIXEL_PNG.split(",")[1] ?? "", "base64");
    const chunks: Buffer[] = [];
    for (let offset = 8; offset < source.length; ) {
      const length = source.readUInt32BE(offset);
      chunks.push(source.subarray(offset, offset + length + 12));
      offset += length + 12;
    }
    const [ihdr, idat, iend] = chunks;
    if (!ihdr || !idat || !iend) throw new Error("fixture chunks missing");
    const signature = source.subarray(0, 8);
    const dataUrls = [
      Buffer.concat([signature, ihdr, ihdr, idat, iend]),
      Buffer.concat([signature, ihdr, idat, pngChunk("tEXt", Buffer.from("x\0y")), idat, iend]),
    ].map((bytes) => `data:image/png;base64,${bytes.toString("base64")}`);
    dataUrls.push(grayscalePng(1, 1, 1));

    for (const dataUrl of dataUrls) {
      expect(() => sanitizeEvidenceImage({ mimeType: "image/png", dataUrl })).toThrow(
        "invalid evidence image",
      );
    }
  });

  it("accepts the exact pixel budget and rejects either oversized dimension", () => {
    expect(() =>
      sanitizeEvidenceImage({ mimeType: "image/png", dataUrl: grayscalePng(2_000, 2_000) }),
    ).not.toThrow();
    expect(() =>
      sanitizeEvidenceImage({ mimeType: "image/png", dataUrl: grayscalePng(2_049, 1) }),
    ).toThrow("invalid evidence image");
  });

  it("rejects an encoded PNG larger than the two MiB source boundary", () => {
    expect(() =>
      sanitizeEvidenceImage({
        mimeType: "image/png",
        dataUrl: withChunkBeforeIend("teXt", "x".repeat(2 * 1024 * 1024)),
      }),
    ).toThrow("invalid evidence image");
  });

  it("rejects a decoded image above the independent four-million-pixel budget", () => {
    expect(() =>
      sanitizeEvidenceImage({
        mimeType: "image/png",
        dataUrl: grayscalePng(2_001, 2_000),
      }),
    ).toThrow("invalid evidence image");
  });
});
