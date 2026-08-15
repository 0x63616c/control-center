import { describe, expect, it } from "vitest";
import { EVIDENCE_MAX_BYTES, EVIDENCE_MAX_FILES } from "../../../contracts";
import { validateEvidenceFiles } from "./evidence-files";

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
});
