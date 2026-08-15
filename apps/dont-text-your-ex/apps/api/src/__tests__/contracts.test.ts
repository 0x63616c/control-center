import { describe, expect, it } from "vitest";
import {
  AVATAR_MAX_BYTES,
  AvatarPhotoDataUrlSchema,
  CloseJarRequestSchema,
  CreateJarRequestSchema,
  CreateReportRequestSchema,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_FILES,
  EvidenceImageInputSchema,
  InviteCodeSchema,
  JarIdSchema,
  JoinJarRequestSchema,
  LogSlipRequestSchema,
  ReportIdSchema,
  ResolveReportRequestSchema,
  ShareStreakRequestSchema,
  UpdateMeRequestSchema,
  UserIdSchema,
} from "../../../../contracts";
import { parseEvidenceImageJson, serializeEvidenceImageJson } from "../persistence";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const JPEG_DATA_URL = "data:image/jpeg;base64,/9j/AA==";
const WEBP_DATA_URL = "data:image/webp;base64,UklGRgAAAABXRUJQ";

describe("request schemas", () => {
  it.each([
    ["profile patch", UpdateMeRequestSchema, { exes: "not-an-array" }],
    ["jar creation", CreateJarRequestSchema, { name: "", defaultCents: -1 }],
    ["jar join", JoinJarRequestSchema, { code: 42 }],
    ["streak sharing", ShareStreakRequestSchema, { value: "yes" }],
    ["slip logging", LogSlipRequestSchema, { amountCents: Number.NaN }],
    ["report creation", CreateReportRequestSchema, { accusedId: "jar_wrong" }],
    ["report resolution", ResolveReportRequestSchema, { action: "delete" }],
    ["jar closure", CloseJarRequestSchema, { confirmed: false }],
  ])("rejects invalid %s JSON", (_name, schema, raw) => {
    expect(schema.safeParse(raw).success).toBe(false);
  });

  it("accepts only an explicit close-jar confirmation", () => {
    expect(CloseJarRequestSchema.parse({ confirmed: true })).toEqual({ confirmed: true });
    expect(CloseJarRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("avatar photo boundary", () => {
  it.each([
    PNG_DATA_URL,
    JPEG_DATA_URL,
    WEBP_DATA_URL,
  ])("accepts a supported image with a matching signature", (dataUrl) => {
    expect(AvatarPhotoDataUrlSchema.safeParse(dataUrl).success).toBe(true);
  });

  it("rejects arbitrary or MIME-spoofed data", () => {
    expect(AvatarPhotoDataUrlSchema.safeParse("https://example.invalid/avatar.png").success).toBe(
      false,
    );
    expect(
      AvatarPhotoDataUrlSchema.safeParse("data:image/png;base64,R0lGODlhAQABAIAAAAAAAP///yw=")
        .success,
    ).toBe(false);
    expect(
      AvatarPhotoDataUrlSchema.safeParse(PNG_DATA_URL.replace("image/png", "image/jpeg")).success,
    ).toBe(false);
  });

  it("rejects oversized avatar data", () => {
    const oversized = `data:image/png;base64,${Buffer.alloc(AVATAR_MAX_BYTES + 1).toString("base64")}`;
    expect(AvatarPhotoDataUrlSchema.safeParse(oversized).success).toBe(false);
  });
});

describe("domain id parsers", () => {
  it("does not allow user, jar, and report ids to cross domains", () => {
    expect(UserIdSchema.safeParse("usr_123").success).toBe(true);
    expect(JarIdSchema.safeParse("usr_123").success).toBe(false);
    expect(ReportIdSchema.safeParse("jar_123").success).toBe(false);
  });

  it("normalizes valid invite codes and rejects malformed codes", () => {
    expect(InviteCodeSchema.parse("xex24k")).toBe("XEX24K");
    expect(InviteCodeSchema.safeParse("short").success).toBe(false);
    expect(InviteCodeSchema.safeParse("XEX24!").success).toBe(false);
    expect(JoinJarRequestSchema.parse({ code: "xex24k" })).toEqual({ code: "XEX24K" });
  });
});

describe("persisted report evidence", () => {
  it("accepts real bounded image data and requires a note or image", () => {
    expect(
      EvidenceImageInputSchema.safeParse({ mimeType: "image/png", dataUrl: PNG_DATA_URL }).success,
    ).toBe(true);
    expect(
      CreateReportRequestSchema.safeParse({ accusedId: "usr_123", anonymous: false }).success,
    ).toBe(false);
    expect(
      CreateReportRequestSchema.safeParse({
        accusedId: "usr_123",
        anonymous: false,
        evidence: [{ mimeType: "image/png", dataUrl: PNG_DATA_URL }],
      }).success,
    ).toBe(true);
  });

  it("rejects unsupported, oversized, and excess attachments", () => {
    const oversized = `data:image/png;base64,${Buffer.alloc(EVIDENCE_MAX_BYTES + 1).toString("base64")}`;
    expect(
      EvidenceImageInputSchema.safeParse({ mimeType: "image/gif", dataUrl: PNG_DATA_URL }).success,
    ).toBe(false);
    expect(
      EvidenceImageInputSchema.safeParse({ mimeType: "image/png", dataUrl: oversized }).success,
    ).toBe(false);
    expect(
      CreateReportRequestSchema.safeParse({
        accusedId: "usr_123",
        evidence: Array.from({ length: EVIDENCE_MAX_FILES + 1 }, () => ({
          mimeType: "image/png",
          dataUrl: PNG_DATA_URL,
        })),
      }).success,
    ).toBe(false);
  });

  it("parses valid persisted image JSON and rejects corrupt persisted JSON", () => {
    const image = { mimeType: "image/png" as const, dataUrl: PNG_DATA_URL };

    expect(parseEvidenceImageJson(serializeEvidenceImageJson(image))).toEqual(image);
    expect(() => parseEvidenceImageJson('{"mimeType":"image/png","dataUrl":"nope"}')).toThrow(
      "invalid persisted report evidence",
    );
  });
});
