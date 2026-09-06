import { z } from "zod";

export * from "./notifications";

const idSchema = <Prefix extends string, Brand extends string>(prefix: Prefix, brand: Brand) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`), `invalid ${brand}`)
    .brand<Brand>();

export const UserIdSchema = idSchema("usr", "UserId");
export const JarIdSchema = idSchema("jar", "JarId");
export const ReportIdSchema = idSchema("rpt", "ReportId");
export const RescueInterventionIdSchema = z
  .string()
  .regex(/^rsi_[a-f0-9]{32}$/, "invalid RescueInterventionId")
  .brand<"RescueInterventionId">();
export const AccountDeletionIdSchema = z
  .string()
  .regex(/^del_[a-f0-9]{32}$/, "invalid AccountDeletionId")
  .brand<"AccountDeletionId">();
export const SessionTokenSchema = idSchema("sess", "SessionToken");
const ActivityIdSchema = idSchema("act", "ActivityId");
export const EvidenceIdSchema = idSchema("evi", "EvidenceId");

export type UserId = z.infer<typeof UserIdSchema>;
export type JarId = z.infer<typeof JarIdSchema>;
export type ReportId = z.infer<typeof ReportIdSchema>;
export type RescueInterventionId = z.infer<typeof RescueInterventionIdSchema>;
export type AccountDeletionId = z.infer<typeof AccountDeletionIdSchema>;
export type SessionToken = z.infer<typeof SessionTokenSchema>;

export function accountMutationLockKey(userId: UserId): string {
  return `dont-text-your-ex/account/${userId}`;
}

export const InviteCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{6}$/, "invalid InviteCode"))
  .brand<"InviteCode">();
export type InviteCode = z.infer<typeof InviteCodeSchema>;

const nonEmptyText = z.string().trim().min(1);
const cents = z.number().int().positive();

export const AuthDevRequestSchema = z
  .object({
    as: z.enum(["new", "calum"]).optional(),
  })
  .strict();

export const AppleAuthRequestSchema = z
  .object({
    identityToken: nonEmptyText,
    authorizationCode: nonEmptyText,
    nonce: z.string().regex(/^nonce_[a-f0-9]{48}$/),
    fullName: z.string().optional(),
  })
  .strict();

export const DeleteAccountRequestSchema = z.union([
  z.object({ confirmed: z.literal(true) }).strict(),
  z
    .object({
      confirmed: z.literal(true),
      authorizationCode: nonEmptyText,
      identityToken: nonEmptyText,
      nonce: z.string().regex(/^nonce_[a-f0-9]{48}$/),
    })
    .strict(),
]);
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequestSchema>;

export const AccountDeletionWorkflowInputSchema = z
  .object({ schemaVersion: z.literal(1), deletionRequestId: AccountDeletionIdSchema })
  .strict();
export type AccountDeletionWorkflowInput = z.infer<typeof AccountDeletionWorkflowInputSchema>;

export const CreateJarRequestSchema = z
  .object({
    name: nonEmptyText,
    rule: z.string().optional(),
    defaultCents: cents.optional(),
  })
  .strict();

export const JoinJarRequestSchema = z.object({ code: InviteCodeSchema }).strict();
export const ShareStreakRequestSchema = z.object({ value: z.boolean() }).strict();
export const LogSlipRequestSchema = z
  .object({
    amountCents: cents,
    note: z.string().optional(),
    exLabel: z.string().optional(),
  })
  .strict();

export const EVIDENCE_MAX_FILES = 3;
export const EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const EVIDENCE_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

function decodedBase64Bytes(payload: string): number | null {
  if (payload.length === 0 || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    return null;
  }
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return (payload.length / 4) * 3 - padding;
}

function base64PrefixBytes(payload: string, count: number): readonly number[] {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes: number[] = [];
  for (let offset = 0; offset + 3 < payload.length && bytes.length < count; offset += 4) {
    const a = alphabet.indexOf(payload[offset] ?? "");
    const b = alphabet.indexOf(payload[offset + 1] ?? "");
    const c = alphabet.indexOf(payload[offset + 2] ?? "");
    const d = alphabet.indexOf(payload[offset + 3] ?? "");
    if (a < 0 || b < 0) break;
    bytes.push((a << 2) | (b >> 4));
    if (c >= 0) bytes.push(((b & 15) << 4) | (c >> 2));
    if (d >= 0 && c >= 0) bytes.push(((c & 3) << 6) | d);
  }
  return bytes.slice(0, count);
}

function hasImageSignature(mimeType: (typeof EVIDENCE_IMAGE_MIME_TYPES)[number], payload: string) {
  const bytes = base64PrefixBytes(payload, 12);
  if (mimeType === "image/png") {
    return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  }
  if (mimeType === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return (
    bytes[0] === 82 &&
    bytes[1] === 73 &&
    bytes[2] === 70 &&
    bytes[3] === 70 &&
    bytes[8] === 87 &&
    bytes[9] === 69 &&
    bytes[10] === 66 &&
    bytes[11] === 80
  );
}

export const EvidenceImageInputSchema = z
  .object({
    mimeType: z.enum(EVIDENCE_IMAGE_MIME_TYPES),
    dataUrl: z.string(),
  })
  .strict()
  .superRefine((image, ctx) => {
    const prefix = `data:${image.mimeType};base64,`;
    if (!image.dataUrl.startsWith(prefix)) {
      ctx.addIssue({ code: "custom", path: ["dataUrl"], message: "image data URL MIME mismatch" });
      return;
    }
    const bytes = decodedBase64Bytes(image.dataUrl.slice(prefix.length));
    if (bytes == null) {
      ctx.addIssue({ code: "custom", path: ["dataUrl"], message: "invalid base64 image data" });
    } else if (bytes > EVIDENCE_MAX_BYTES) {
      ctx.addIssue({ code: "custom", path: ["dataUrl"], message: "image exceeds size limit" });
    } else if (!hasImageSignature(image.mimeType, image.dataUrl.slice(prefix.length))) {
      ctx.addIssue({ code: "custom", path: ["dataUrl"], message: "image signature mismatch" });
    }
  });

export const AvatarPhotoDataUrlSchema = z.string().superRefine((dataUrl, ctx) => {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.*)$/.exec(dataUrl);
  if (!match) {
    ctx.addIssue({ code: "custom", message: "avatar must be a supported image data URL" });
    return;
  }
  const mimeType = EVIDENCE_IMAGE_MIME_TYPES.find((candidate) => candidate === match[1]);
  if (!mimeType) {
    ctx.addIssue({ code: "custom", message: "unsupported avatar image type" });
    return;
  }
  const payload = match[2];
  const bytes = decodedBase64Bytes(payload);
  if (bytes == null) {
    ctx.addIssue({ code: "custom", message: "invalid base64 avatar data" });
  } else if (bytes > AVATAR_MAX_BYTES) {
    ctx.addIssue({ code: "custom", message: "avatar exceeds size limit" });
  } else if (!hasImageSignature(mimeType, payload)) {
    ctx.addIssue({ code: "custom", message: "avatar image signature mismatch" });
  }
});

export const UpdateMeRequestSchema = z
  .object({
    name: nonEmptyText.optional(),
    color: z.string().optional(),
    emoji: z.string().nullable().optional(),
    photo: AvatarPhotoDataUrlSchema.nullable().optional(),
    exes: z.array(z.string()).optional(),
  })
  .strict();

export const CreateReportRequestSchema = z
  .object({
    accusedId: UserIdSchema,
    note: nonEmptyText.optional(),
    anonymous: z.boolean().optional(),
    amountCents: cents.optional(),
    evidence: z.array(EvidenceImageInputSchema).max(EVIDENCE_MAX_FILES).optional(),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (report.note == null && (report.evidence?.length ?? 0) === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "a note or image attachment is required",
      });
    }
  });

export const ResolveReportRequestSchema = z.object({ action: z.enum(["own", "deny"]) }).strict();
export const RescueCommandRequestSchema = z
  .object({ action: z.enum(["safe", "slipped", "extend"]) })
  .strict();
export const CloseJarRequestSchema = z.object({ confirmed: z.literal(true) }).strict();
export const LeaveJarRequestSchema = z.object({ confirmed: z.literal(true) }).strict();
export const RotateInviteRequestSchema = z.object({ confirmed: z.literal(true) }).strict();

export type AppleAuthRequest = z.infer<typeof AppleAuthRequestSchema>;
export type UpdateMeRequest = z.infer<typeof UpdateMeRequestSchema>;

export const IanaTimeZoneSchema = z
  .string()
  .refine((value) => value === "UTC" || value.includes("/"), "timezone must be an IANA name")
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
      return true;
    } catch {
      return false;
    }
  }, "invalid IANA timezone")
  .brand<"IanaTimeZone">();
export type IanaTimeZone = z.infer<typeof IanaTimeZoneSchema>;
export const UpdateTimeZoneRequestSchema = z.object({ timezone: IanaTimeZoneSchema }).strict();
export type UpdateTimeZoneRequest = z.infer<typeof UpdateTimeZoneRequestSchema>;
export type CreateJarRequest = z.infer<typeof CreateJarRequestSchema>;
export type LogSlipRequest = z.infer<typeof LogSlipRequestSchema>;
export type EvidenceImageInput = z.infer<typeof EvidenceImageInputSchema>;
export type CreateReportRequest = z.infer<typeof CreateReportRequestSchema>;
export type RescueCommandRequest = z.infer<typeof RescueCommandRequestSchema>;

const rescueBase = {
  id: RescueInterventionIdSchema,
  startedAt: z.number().int().nonnegative(),
  deadlineAt: z.number().int().nonnegative(),
  extensionCount: z.number().int().min(0).max(2),
  aggregateVersion: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
} as const;

export const RescueInterventionSchema = z.discriminatedUnion("status", [
  z.object({ ...rescueBase, status: z.literal("active") }).strict(),
  z
    .object({
      ...rescueBase,
      status: z.literal("check_in_due"),
      checkInDueAt: z.number().int().nonnegative(),
      responseDeadlineAt: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...rescueBase,
      status: z.literal("safe"),
      resolvedAt: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...rescueBase,
      status: z.literal("slipped"),
      resolvedAt: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...rescueBase,
      status: z.literal("abandoned"),
      resolvedAt: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type RescueIntervention = z.infer<typeof RescueInterventionSchema>;

export const RescueInterventionWorkflowInputSchema = z
  .object({ interventionId: RescueInterventionIdSchema, schemaVersion: z.literal(1) })
  .strict();
export type RescueInterventionWorkflowInput = z.infer<typeof RescueInterventionWorkflowInputSchema>;

export const RescueSignalInputSchema = z
  .object({
    interventionId: RescueInterventionIdSchema,
    expectedAggregateVersion: z.number().int().positive(),
    schemaVersion: z.literal(1),
  })
  .strict();
export type RescueSignalInput = z.infer<typeof RescueSignalInputSchema>;

export const UserSchema = z
  .object({
    id: UserIdSchema,
    name: z.string(),
    color: z.string(),
    emoji: z.string().nullable(),
    photo: z.string().nullable(),
  })
  .strict();

export const MeSchema = UserSchema.extend({
  exes: z.array(z.string()),
  phone: z.string().nullable(),
}).strict();

const visibleMemberFields = {
  user: UserSchema,
  role: z.enum(["owner", "member"]),
  tallyCents: z.number().int().nonnegative(),
  active: z.boolean().default(true),
} as const;

export const MemberSchema = z.discriminatedUnion("shareStreak", [
  z
    .object({
      ...visibleMemberFields,
      daysClean: z.number().int().min(-1),
      shareStreak: z.literal(true),
    })
    .strict(),
  z
    .object({
      ...visibleMemberFields,
      daysClean: z.number().int().min(-1).optional(),
      shareStreak: z.literal(false),
    })
    .strict(),
]);

export const JarSummarySchema = z
  .object({
    id: JarIdSchema,
    name: z.string(),
    rule: z.string(),
    defaultCents: cents,
    memberIds: z.array(UserIdSchema),
    memberCount: z.number().int().nonnegative(),
    jarTotalCents: z.number().int().nonnegative(),
    myTallyCents: z.number().int().nonnegative(),
    myDaysClean: z.number().int().min(-1),
    myShareStreak: z.boolean(),
    closedAt: z.number().int().nullable().default(null),
    closedBy: UserSchema.nullable().default(null),
  })
  .strict();

const ActivityTypeSchema = z.enum(["slip", "report", "join", "milestone", "deny"]);

export const ActivitySchema: z.ZodType<ActivityDTO> = z
  .object({
    id: ActivityIdSchema,
    jarId: JarIdSchema,
    jarName: z.string(),
    reportId: ReportIdSchema.nullable().default(null),
    type: ActivityTypeSchema,
    user: UserSchema.nullable(),
    by: UserSchema.nullable(),
    anonymous: z.boolean(),
    amountCents: z.number().int().nonnegative().nullable(),
    exLabel: z.string().nullable().optional(),
    note: z.string().nullable(),
    text: z.string().nullable(),
    ago: z.string(),
  })
  .strict();

export const JarDetailSchema = z
  .object({
    id: JarIdSchema,
    name: z.string(),
    rule: z.string(),
    defaultCents: cents,
    inviteCode: InviteCodeSchema.nullable(),
    inviteExpiresAt: z.number().int().nullable().default(null),
    jarTotalCents: z.number().int().nonnegative(),
    members: z.array(MemberSchema),
    activity: z.array(ActivitySchema),
    closedAt: z.number().int().nullable().default(null),
    closedBy: UserSchema.nullable().default(null),
  })
  .strict();

export const JarPreviewSchema = z
  .object({
    id: JarIdSchema,
    name: z.string(),
    rule: z.string(),
    defaultCents: cents,
    members: z.array(
      UserSchema.pick({ id: true, name: true, color: true, emoji: true, photo: true }).strict(),
    ),
    memberCount: z.number().int().nonnegative(),
  })
  .strict();

const EvidenceSchema = z
  .object({
    id: EvidenceIdSchema,
    kind: z.literal("image"),
    mimeType: z.enum(EVIDENCE_IMAGE_MIME_TYPES),
    dataUrl: z.string(),
  })
  .strict();

export const ReportStatusSchema = z.enum(["pending", "owned", "denied", "expired"]);
export const ReportAccountabilityWorkflowInputSchema = z
  .object({ schemaVersion: z.literal(1), reportId: ReportIdSchema })
  .strict();
export const ReportAccountabilitySignalSchema = ReportAccountabilityWorkflowInputSchema.extend({
  expectedAggregateVersion: z.number().int().positive(),
}).strict();
export type ReportAccountabilityWorkflowInput = z.infer<
  typeof ReportAccountabilityWorkflowInputSchema
>;
export type ReportAccountabilitySignal = z.infer<typeof ReportAccountabilitySignalSchema>;
export const ReportSchema = z
  .object({
    id: ReportIdSchema,
    jarId: JarIdSchema,
    jarName: z.string(),
    accuser: UserSchema.nullable(),
    accused: UserSchema,
    note: z.string().nullable(),
    anonymous: z.boolean(),
    amountCents: cents,
    status: ReportStatusSchema,
    ago: z.string(),
    evidence: z.array(EvidenceSchema),
  })
  .strict();

export const AuthResponseSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("authenticated"), token: SessionTokenSchema, user: MeSchema })
    .strict(),
  z
    .object({ status: z.literal("needs_profile"), token: SessionTokenSchema, user: MeSchema })
    .strict(),
]);
export const DeleteAccountResponseSchema = z
  .object({
    status: z.literal("accepted"),
    deletionRequestId: AccountDeletionIdSchema,
  })
  .strict();
export const OkResponseSchema = z.object({ ok: z.literal(true) }).strict();
export const JoinJarResponseSchema = z.object({ jarId: JarIdSchema }).strict();
export const InviteRateLimitErrorSchema = z
  .object({
    error: z.literal("invite_rate_limited"),
    retryAfterSeconds: z.number().int().positive(),
  })
  .strict();
const GeneralApiErrorBodySchema = z
  .object({
    error: z.string(),
    message: z.string().optional(),
    expectedAud: z.string().optional(),
  })
  .strict();
export const ApiErrorBodySchema = z.union([InviteRateLimitErrorSchema, GeneralApiErrorBodySchema]);

export type UserDTO = z.infer<typeof UserSchema>;
export type MeDTO = z.infer<typeof MeSchema>;
export type MemberDTO = z.infer<typeof MemberSchema>;
export type JarSummaryDTO = z.infer<typeof JarSummarySchema>;
export type ActivityType = z.infer<typeof ActivityTypeSchema>;
export interface ActivityDTO {
  readonly id: z.infer<typeof ActivityIdSchema>;
  readonly jarId: JarId;
  readonly jarName: string;
  readonly reportId: ReportId | null;
  readonly type: ActivityType;
  readonly user: UserDTO | null;
  readonly by: UserDTO | null;
  readonly anonymous: boolean;
  readonly amountCents: number | null;
  readonly exLabel?: string | null;
  readonly note: string | null;
  readonly text: string | null;
  readonly ago: string;
}
export type JarDetailDTO = z.infer<typeof JarDetailSchema>;
export type JarPreviewDTO = z.infer<typeof JarPreviewSchema>;
export type ReportDTO = z.infer<typeof ReportSchema>;
export type RescueInterventionDTO = z.infer<typeof RescueInterventionSchema>;
