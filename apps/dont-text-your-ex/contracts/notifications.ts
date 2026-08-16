import { z } from "zod";

const notificationIdSchema = <Brand extends string>(prefix: string, brand: Brand) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`), `invalid ${brand}`)
    .brand<Brand>();

export const PushInstallationIdSchema = notificationIdSchema("dev", "PushInstallationId");
export const NotificationIdSchema = z
  .string()
  .regex(/^ntf_[a-f0-9]{32}$/, "invalid NotificationId")
  .brand<"NotificationId">();
export const NotificationDeliveryIdSchema = notificationIdSchema("ndl", "NotificationDeliveryId");

export type PushInstallationId = z.infer<typeof PushInstallationIdSchema>;
export type NotificationId = z.infer<typeof NotificationIdSchema>;
export type NotificationDeliveryId = z.infer<typeof NotificationDeliveryIdSchema>;

export const NOTIFICATION_CATEGORIES = {
  report: { defaultEnabled: true, label: "Reports", configurable: true },
  rescue: { defaultEnabled: true, label: "Rescue reminders", configurable: true },
  slip: { defaultEnabled: false, label: "Slips", configurable: true },
  join: { defaultEnabled: false, label: "New members", configurable: true },
  jar_milestone: { defaultEnabled: false, label: "Jar milestones", configurable: true },
  streak_milestone: { defaultEnabled: false, label: "Streak milestones", configurable: true },
  recap: { defaultEnabled: false, label: "Monthly recaps", configurable: true },
  invite: { defaultEnabled: false, label: "Invite reminders", configurable: true },
  account_deletion: {
    defaultEnabled: false,
    label: "Account deletion",
    configurable: false,
  },
} as const satisfies Record<
  string,
  { readonly defaultEnabled: boolean; readonly label: string; readonly configurable: boolean }
>;

export const NotificationCategorySchema = z.enum(
  Object.keys(NOTIFICATION_CATEGORIES) as [
    keyof typeof NOTIFICATION_CATEGORIES,
    ...(keyof typeof NOTIFICATION_CATEGORIES)[],
  ],
);
export type NotificationCategory = z.infer<typeof NotificationCategorySchema>;

export const NotificationPreferencesSchema = z.object(
  Object.fromEntries(
    Object.keys(NOTIFICATION_CATEGORIES).map((category) => [category, z.boolean()]),
  ) as Record<NotificationCategory, z.ZodBoolean>,
);
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

export const UpdateNotificationPreferencesRequestSchema = NotificationPreferencesSchema.partial()
  .refine((patch) => Object.keys(patch).length > 0, "at least one preference is required")
  .refine((patch) => !("account_deletion" in patch), "account deletion push is immutable")
  .strict();
export type UpdateNotificationPreferencesRequest = z.infer<
  typeof UpdateNotificationPreferencesRequestSchema
>;

export const RegisterPushDeviceRequestSchema = z
  .object({
    installationId: PushInstallationIdSchema,
    token: z
      .string()
      .trim()
      .regex(/^[a-fA-F0-9]{32,256}$/)
      .transform((value) => value.toLowerCase()),
    platform: z.literal("ios"),
    environment: z.enum(["production", "sandbox"]),
    appVersion: z.string().trim().min(1).max(64),
    appBuild: z.string().trim().min(1).max(64),
  })
  .strict();
export type RegisterPushDeviceRequest = z.infer<typeof RegisterPushDeviceRequestSchema>;

export const DisablePushDeviceRequestSchema = z
  .object({ installationId: PushInstallationIdSchema })
  .strict();

export const PushRegistrationResponseSchema = z
  .object({ status: z.literal("registered") })
  .strict();

export const NotificationTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("activity") }).strict(),
  z
    .object({ type: z.literal("report"), reportId: z.string().regex(/^rpt_[A-Za-z0-9]+$/) })
    .strict(),
  z.object({ type: z.literal("jar"), jarId: z.string().regex(/^jar_[A-Za-z0-9]+$/) }).strict(),
  z.object({ type: z.literal("profile") }).strict(),
  z.object({ type: z.literal("unavailable") }).strict(),
]);
export type NotificationTarget = z.infer<typeof NotificationTargetSchema>;

export const NotificationDeliveryWorkflowInputSchema = z
  .object({ notificationId: NotificationIdSchema, schemaVersion: z.literal(1) })
  .strict();
export type NotificationDeliveryWorkflowInput = z.infer<
  typeof NotificationDeliveryWorkflowInputSchema
>;
