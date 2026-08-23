import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AccountDeletionWorkflowInputSchema,
  AppleAuthRequestSchema,
  AVATAR_MAX_BYTES,
  AvatarPhotoDataUrlSchema,
  CloseJarRequestSchema,
  CreateJarRequestSchema,
  CreateReportRequestSchema,
  DeleteAccountRequestSchema,
  DeleteAccountResponseSchema,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_FILES,
  EvidenceImageInputSchema,
  IanaTimeZoneSchema,
  type InviteCode,
  InviteCodeSchema,
  type JarId,
  JarIdSchema,
  JoinJarRequestSchema,
  LeaveJarRequestSchema,
  LogSlipRequestSchema,
  NotificationDeliveryWorkflowInputSchema,
  ReportAccountabilitySignalSchema,
  ReportAccountabilityWorkflowInputSchema,
  type ReportId,
  ReportIdSchema,
  ReportStatusSchema,
  RescueCommandRequestSchema,
  RescueInterventionSchema,
  RescueInterventionWorkflowInputSchema,
  ResolveReportRequestSchema,
  ShareStreakRequestSchema,
  UpdateMeRequestSchema,
  type UserId,
  UserIdSchema,
} from "../../../../contracts";
import { parseEvidenceImageJson, serializeEvidenceImageJson } from "../persistence";
import type * as store from "../store";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const JPEG_DATA_URL = "data:image/jpeg;base64,/9j/AA==";
const WEBP_DATA_URL = "data:image/webp;base64,UklGRgAAAABXRUJQ";

describe("request schemas", () => {
  it("keeps account deletion confirmation and workflow history minimal and opaque", () => {
    const request = {
      confirmed: true,
      authorizationCode: "single-use-authorization-code",
      identityToken: "signed.identity.token",
      nonce: "nonce_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const response = {
      status: "accepted",
      deletionRequestId: "del_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const workflow = {
      schemaVersion: 1,
      deletionRequestId: response.deletionRequestId,
    };

    expect(DeleteAccountRequestSchema.parse(request)).toEqual(request);
    expect(DeleteAccountRequestSchema.parse({ confirmed: true })).toEqual({ confirmed: true });
    expect(
      DeleteAccountRequestSchema.safeParse({
        confirmed: true,
        authorizationCode: request.authorizationCode,
      }).success,
    ).toBe(false);
    expect(DeleteAccountRequestSchema.safeParse({ confirmed: false }).success).toBe(false);
    expect(DeleteAccountResponseSchema.parse(response)).toEqual(response);
    expect(AccountDeletionWorkflowInputSchema.parse(workflow)).toEqual(workflow);
    expect(
      AccountDeletionWorkflowInputSchema.safeParse({ ...workflow, userId: "usr_private" }).success,
    ).toBe(false);
  });

  it("carries the single-use Apple authorization code only through the strict sign-in request", () => {
    const request = {
      identityToken: "signed.identity.token",
      authorizationCode: "single-use-authorization-code",
      nonce: "nonce_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };

    expect(AppleAuthRequestSchema.parse(request)).toEqual(request);
    expect(
      AppleAuthRequestSchema.safeParse({
        identityToken: request.identityToken,
        nonce: request.nonce,
      }).success,
    ).toBe(false);
    expect(AppleAuthRequestSchema.safeParse({ ...request, authorizationCode: "" }).success).toBe(
      false,
    );
  });

  it("exposes expired as a terminal report status", () => {
    expect(ReportStatusSchema.parse("expired")).toBe("expired");
  });

  it("keeps report workflow arguments opaque and exact", () => {
    const start = {
      schemaVersion: 1,
      reportId: "rpt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    expect(ReportAccountabilityWorkflowInputSchema.parse(start)).toEqual(start);
    expect(
      ReportAccountabilityWorkflowInputSchema.safeParse({ ...start, anonymous: true }).success,
    ).toBe(false);
    expect(
      ReportAccountabilitySignalSchema.parse({ ...start, expectedAggregateVersion: 2 }),
    ).toEqual({ ...start, expectedAggregateVersion: 2 });
  });

  it("locks rescue workflow history to one opaque intervention id and schema version", () => {
    const input = {
      schemaVersion: 1,
      interventionId: "rsi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    expect(RescueInterventionWorkflowInputSchema.parse(input)).toEqual(input);
    expect(
      RescueInterventionWorkflowInputSchema.safeParse({ ...input, messageDraft: "do not persist" })
        .success,
    ).toBe(false);
  });

  it("models every rescue state as a strict discriminated union", () => {
    const common = {
      id: "rsi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      startedAt: 1_000,
      deadlineAt: 601_000,
      extensionCount: 0,
      aggregateVersion: 1,
      updatedAt: 1_000,
    };
    expect(RescueInterventionSchema.parse({ ...common, status: "active" })).toMatchObject({
      status: "active",
    });
    expect(
      RescueInterventionSchema.parse({
        ...common,
        status: "check_in_due",
        checkInDueAt: 601_000,
        responseDeadlineAt: 901_000,
      }),
    ).toMatchObject({ status: "check_in_due" });
    for (const status of ["safe", "slipped", "abandoned"] as const) {
      expect(
        RescueInterventionSchema.parse({ ...common, status, resolvedAt: 901_000 }),
      ).toMatchObject({ status });
    }
    expect(
      RescueInterventionSchema.safeParse({ ...common, status: "active", messageDraft: "private" })
        .success,
    ).toBe(false);
    expect(RescueCommandRequestSchema.safeParse({ action: "charge" }).success).toBe(false);
  });

  it("accepts only canonical IANA-style device timezones", () => {
    expect(IanaTimeZoneSchema.safeParse("America/Los_Angeles").success).toBe(true);
    expect(IanaTimeZoneSchema.safeParse("UTC").success).toBe(true);
    expect(IanaTimeZoneSchema.safeParse("PST").success).toBe(false);
    expect(IanaTimeZoneSchema.safeParse("Not/AZone").success).toBe(false);
  });

  it("keeps notification workflow start input limited to its opaque id", () => {
    const exact = {
      schemaVersion: 1,
      notificationId: "ntf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    expect(NotificationDeliveryWorkflowInputSchema.parse(exact)).toEqual(exact);
    expect(
      NotificationDeliveryWorkflowInputSchema.safeParse({ ...exact, aggregateVersion: 1 }).success,
    ).toBe(false);
  });

  it.each([
    ["profile patch", UpdateMeRequestSchema, { exes: "not-an-array" }],
    ["jar creation", CreateJarRequestSchema, { name: "", defaultCents: -1 }],
    ["jar join", JoinJarRequestSchema, { code: 42 }],
    ["streak sharing", ShareStreakRequestSchema, { value: "yes" }],
    ["slip logging", LogSlipRequestSchema, { amountCents: Number.NaN }],
    ["report creation", CreateReportRequestSchema, { accusedId: "jar_wrong" }],
    ["report resolution", ResolveReportRequestSchema, { action: "delete" }],
    ["jar closure", CloseJarRequestSchema, { confirmed: false }],
    ["jar leave", LeaveJarRequestSchema, { confirmed: false }],
  ])("rejects invalid %s JSON", (_name, schema, raw) => {
    expect(schema.safeParse(raw).success).toBe(false);
  });

  it("accepts only an explicit close-jar confirmation", () => {
    expect(CloseJarRequestSchema.parse({ confirmed: true })).toEqual({ confirmed: true });
    expect(CloseJarRequestSchema.safeParse({}).success).toBe(false);
  });

  it("accepts only an explicit leave-jar confirmation", () => {
    expect(LeaveJarRequestSchema.parse({ confirmed: true })).toEqual({ confirmed: true });
    expect(LeaveJarRequestSchema.safeParse({}).success).toBe(false);
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
  it("keeps six-character invite codes on a cryptographic uniform source", () => {
    const source = readFileSync(new URL("../ids.ts", import.meta.url), "utf8");

    expect(source).toContain('from "node:crypto"');
    expect(source).toContain("randomInt(CODE_ALPHABET.length)");
    expect(source).not.toContain("Math.random");
  });

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

  it("preserves branded ids across persistence seams", () => {
    expectTypeOf<Parameters<typeof store.getJarDetail>[0]>().toEqualTypeOf<JarId>();
    expectTypeOf<Parameters<typeof store.getJarDetail>[1]>().toEqualTypeOf<UserId>();
    expectTypeOf<Parameters<typeof store.reportForUser>[0]>().toEqualTypeOf<ReportId>();
    expectTypeOf<Parameters<typeof store.joinJarByCode>[1]>().toEqualTypeOf<InviteCode>();
  });
});

describe("persisted report evidence", () => {
  it("accepts PNG, JPEG, and WebP signatures and requires a note or image", () => {
    for (const [mimeType, dataUrl] of [
      ["image/png", PNG_DATA_URL],
      ["image/jpeg", JPEG_DATA_URL],
      ["image/webp", WEBP_DATA_URL],
    ] as const) {
      expect(EvidenceImageInputSchema.safeParse({ mimeType, dataUrl }).success).toBe(true);
    }
    expect(
      CreateReportRequestSchema.safeParse({ accusedId: "usr_123", anonymous: false }).success,
    ).toBe(false);
    expect(
      CreateReportRequestSchema.safeParse({
        accusedId: "usr_123",
        note: "   ",
        anonymous: false,
      }).success,
    ).toBe(false);
    expect(
      CreateReportRequestSchema.safeParse({
        accusedId: "usr_123",
        note: "Observed a message",
        anonymous: false,
      }).success,
    ).toBe(true);
    expect(
      CreateReportRequestSchema.safeParse({
        accusedId: "usr_123",
        anonymous: false,
        evidence: [{ mimeType: "image/png", dataUrl: PNG_DATA_URL }],
      }).success,
    ).toBe(true);
  });

  it("rejects MIME spoofing, malformed base64, unsupported, oversized, and excess attachments", () => {
    const oversized = `data:image/png;base64,${Buffer.alloc(EVIDENCE_MAX_BYTES + 1).toString("base64")}`;
    expect(
      EvidenceImageInputSchema.safeParse({ mimeType: "image/jpeg", dataUrl: PNG_DATA_URL }).success,
    ).toBe(false);
    expect(
      EvidenceImageInputSchema.safeParse({
        mimeType: "image/png",
        dataUrl: PNG_DATA_URL.replace("iVBOR", "R0lGO"),
      }).success,
    ).toBe(false);
    expect(
      EvidenceImageInputSchema.safeParse({
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,not-base64!",
      }).success,
    ).toBe(false);
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

  it("accepts exactly three attachments and exactly 2 MiB per image", () => {
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const exactLimit = `data:image/png;base64,${Buffer.concat([
      pngSignature,
      Buffer.alloc(EVIDENCE_MAX_BYTES - pngSignature.length),
    ]).toString("base64")}`;
    const image = { mimeType: "image/png" as const, dataUrl: exactLimit };

    expect(EvidenceImageInputSchema.safeParse(image).success).toBe(true);
    expect(
      CreateReportRequestSchema.safeParse({
        accusedId: "usr_123",
        evidence: Array.from({ length: EVIDENCE_MAX_FILES }, () => image),
      }).success,
    ).toBe(true);
  });

  it("parses valid persisted image JSON and rejects corrupt persisted JSON", () => {
    const image = { mimeType: "image/png" as const, dataUrl: PNG_DATA_URL };

    expect(parseEvidenceImageJson(serializeEvidenceImageJson(image))).toEqual(image);
    expect(() => parseEvidenceImageJson('{"mimeType":"image/png","dataUrl":"nope"}')).toThrow(
      "invalid persisted report evidence",
    );
  });
});
