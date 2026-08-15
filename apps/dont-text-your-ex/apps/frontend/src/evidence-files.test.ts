import { describe, expect, it } from "vitest";
import { EVIDENCE_MAX_FILES } from "../../../contracts";
import { SOURCE_IMAGE_MAX_BYTES, validateEvidenceFiles } from "./evidence-files";

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

  it("accepts iPhone HEIC sources for browser decoding", () => {
    const files = [imageFile("IMG_1234.HEIC", "image/heic")];
    expect(validateEvidenceFiles(files)).toEqual({ ok: true, files });
  });

  it("accepts large camera sources but rejects unreasonable source files", () => {
    const cameraPhoto = imageFile("camera.jpg", "image/jpeg", 8 * 1024 * 1024);
    expect(validateEvidenceFiles([cameraPhoto])).toEqual({ ok: true, files: [cameraPhoto] });

    expect(
      validateEvidenceFiles([imageFile("huge.png", "image/png", SOURCE_IMAGE_MAX_BYTES + 1)]),
    ).toEqual({ ok: false, error: "file_too_large" });
  });

  it("rejects more than the attachment limit", () => {
    const files = Array.from({ length: EVIDENCE_MAX_FILES + 1 }, (_, index) =>
      imageFile(`${index}.png`),
    );
    expect(validateEvidenceFiles(files)).toEqual({ ok: false, error: "too_many_files" });
  });
});
