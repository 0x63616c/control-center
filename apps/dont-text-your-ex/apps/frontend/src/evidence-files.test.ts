import { describe, expect, it } from "vitest";
import { EVIDENCE_MAX_BYTES, EVIDENCE_MAX_FILES } from "../../../contracts";
import {
  type EvidenceImageRuntime,
  readEvidenceFilesWithRuntime,
  validateEvidenceFiles,
} from "./evidence-files";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function imageFile(name: string, type = "image/png", size = 1): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe("report evidence file selection", () => {
  it("accepts bounded PNG, JPEG, and WebP files", () => {
    const files = [
      imageFile("one.png", "image/png"),
      imageFile("two.jpg", "image/jpeg"),
      imageFile("three.webp", "image/webp"),
    ];

    expect(validateEvidenceFiles(files)).toEqual({ ok: true, files });
  });

  it("rejects unsupported image formats", () => {
    expect(validateEvidenceFiles([imageFile("animated.gif", "image/gif")])).toEqual({
      ok: false,
      error: "unsupported_type",
    });
  });

  it("rejects files larger than the per-image limit", () => {
    expect(
      validateEvidenceFiles([imageFile("huge.png", "image/png", EVIDENCE_MAX_BYTES + 1)]),
    ).toEqual({ ok: false, error: "file_too_large" });
  });

  it("rejects more than the attachment limit", () => {
    const files = Array.from({ length: EVIDENCE_MAX_FILES + 1 }, (_, index) =>
      imageFile(`${index}.png`),
    );
    expect(validateEvidenceFiles(files)).toEqual({ ok: false, error: "too_many_files" });
  });

  it("decodes JPEG and WebP sources with orientation and emits fresh bounded PNGs", async () => {
    const calls: Array<{ width: number; height: number }> = [];
    const runtime: EvidenceImageRuntime<object> = {
      async decode(_file, options) {
        expect(options).toEqual({ imageOrientation: "from-image" });
        return { width: 3_000, height: 2_000, source: {}, close() {} };
      },
      async encodePng(_source, width, height) {
        calls.push({ width, height });
        return new Blob([PNG_BYTES], { type: "image/png" });
      },
    };

    const result = await readEvidenceFilesWithRuntime(
      [imageFile("receipt.jpg", "image/jpeg"), imageFile("receipt.webp", "image/webp")],
      runtime,
    );

    expect(result).toEqual({
      ok: true,
      evidence: [
        expect.objectContaining({
          mimeType: "image/png",
          dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
        }),
        expect.objectContaining({
          mimeType: "image/png",
          dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
        }),
      ],
    });
    expect(calls).toEqual([
      { width: 2_048, height: 1_365 },
      { width: 2_048, height: 1_365 },
    ]);
  });

  it("fails the whole selection when normalized PNG output cannot fit the byte budget", async () => {
    const oversized = new Blob([new Uint8Array(EVIDENCE_MAX_BYTES + 1)], { type: "image/png" });
    const runtime: EvidenceImageRuntime<object> = {
      async decode() {
        return { width: 100, height: 100, source: {}, close() {} };
      },
      async encodePng() {
        return oversized;
      },
    };

    await expect(
      readEvidenceFilesWithRuntime([imageFile("receipt.png")], runtime),
    ).resolves.toEqual({
      ok: false,
      error: "output_too_large",
    });
  });
});
