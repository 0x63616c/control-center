import { z } from "zod";
import { JarIdSchema, ReportIdSchema, RescueInterventionIdSchema } from "../../../contracts";

const opaqueIdSchema = <Brand extends string>(prefix: string, brand: Brand) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[a-f0-9]{32}$`), `invalid ${brand}`)
    .brand<Brand>();

const EventIdSchema = opaqueIdSchema("evt", "EventId");
export const InviteVersionIdSchema = opaqueIdSchema("inv", "InviteVersionId");
export const MembershipTenureIdSchema = opaqueIdSchema("mtn", "MembershipTenureId");
const SlipIdSchema = opaqueIdSchema("slip", "SlipId");
export const JarMilestoneIdSchema = opaqueIdSchema("jms", "JarMilestoneId");
export const StreakAchievementIdSchema = opaqueIdSchema("sta", "StreakAchievementId");
const RecapIdSchema = opaqueIdSchema("rcp", "RecapId");
const NotificationIdSchema = opaqueIdSchema("ntf", "NotificationId");
const AccountDeletionIdSchema = opaqueIdSchema("del", "AccountDeletionId");

export type EventId = z.infer<typeof EventIdSchema>;
export type InviteVersionId = z.infer<typeof InviteVersionIdSchema>;
export type MembershipTenureId = z.infer<typeof MembershipTenureIdSchema>;
export type SlipId = z.infer<typeof SlipIdSchema>;
export type JarMilestoneId = z.infer<typeof JarMilestoneIdSchema>;
export type RescueInterventionId = z.infer<typeof RescueInterventionIdSchema>;
export type StreakAchievementId = z.infer<typeof StreakAchievementIdSchema>;
export type RecapId = z.infer<typeof RecapIdSchema>;
export type NotificationId = z.infer<typeof NotificationIdSchema>;
export type AccountDeletionId = z.infer<typeof AccountDeletionIdSchema>;

const DOMAIN_EVENT_DEFINITIONS = {
  "jar.created": { aggregateType: "jar", schemaVersion: 1 },
  "jar.closed": { aggregateType: "jar", schemaVersion: 1 },
  "invite.issued": { aggregateType: "invite", schemaVersion: 1 },
  "invite.superseded": { aggregateType: "invite", schemaVersion: 1 },
  "membership.joined": { aggregateType: "membership_tenure", schemaVersion: 1 },
  "membership.left": { aggregateType: "membership_tenure", schemaVersion: 1 },
  "slip.logged": { aggregateType: "slip", schemaVersion: 1 },
  "jar.milestone_crossed": { aggregateType: "jar_milestone", schemaVersion: 1 },
  "report.created": { aggregateType: "report", schemaVersion: 1 },
  "report.owned": { aggregateType: "report", schemaVersion: 1 },
  "report.denied": { aggregateType: "report", schemaVersion: 1 },
  "report.expired": { aggregateType: "report", schemaVersion: 1 },
  "report.jar_closed": { aggregateType: "report", schemaVersion: 1 },
  "report.member_departed": { aggregateType: "report", schemaVersion: 1 },
  "rescue.started": { aggregateType: "rescue", schemaVersion: 1 },
  "rescue.extended": { aggregateType: "rescue", schemaVersion: 1 },
  "rescue.safe": { aggregateType: "rescue", schemaVersion: 1 },
  "rescue.slipped": { aggregateType: "rescue", schemaVersion: 1 },
  "rescue.check_in_due": { aggregateType: "rescue", schemaVersion: 1 },
  "rescue.abandoned": { aggregateType: "rescue", schemaVersion: 1 },
  "streak.milestone_reached": { aggregateType: "streak_achievement", schemaVersion: 1 },
  "recap.created": { aggregateType: "recap", schemaVersion: 1 },
  "notification.requested": { aggregateType: "notification", schemaVersion: 1 },
  "account.deletion_requested": { aggregateType: "account_deletion", schemaVersion: 1 },
} as const;

const DomainEventTypeSchema = z.enum(
  Object.keys(DOMAIN_EVENT_DEFINITIONS) as [
    keyof typeof DOMAIN_EVENT_DEFINITIONS,
    ...(keyof typeof DOMAIN_EVENT_DEFINITIONS)[],
  ],
);
export type DomainEventType = z.infer<typeof DomainEventTypeSchema>;

export function domainEventDefinition(type: DomainEventType) {
  return DOMAIN_EVENT_DEFINITIONS[type];
}

const AGGREGATE_ID_SCHEMAS = {
  jar: JarIdSchema,
  invite: InviteVersionIdSchema,
  membership_tenure: MembershipTenureIdSchema,
  slip: SlipIdSchema,
  jar_milestone: JarMilestoneIdSchema,
  report: ReportIdSchema,
  rescue: RescueInterventionIdSchema,
  streak_achievement: StreakAchievementIdSchema,
  recap: RecapIdSchema,
  notification: NotificationIdSchema,
  account_deletion: AccountDeletionIdSchema,
} as const;

export const DomainEventSchema = z
  .object({
    id: EventIdSchema,
    type: DomainEventTypeSchema,
    schemaVersion: z.number().int().positive(),
    aggregateType: z.string().min(1),
    aggregateId: z.string().min(1),
    aggregateVersion: z.number().int().positive(),
    occurredAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((event, context) => {
    const definition = domainEventDefinition(event.type);
    if (event.aggregateType !== definition.aggregateType) {
      context.addIssue({ code: "custom", path: ["aggregateType"], message: "aggregate mismatch" });
    }
    if (event.schemaVersion !== definition.schemaVersion) {
      context.addIssue({ code: "custom", path: ["schemaVersion"], message: "version mismatch" });
    }
    if (!AGGREGATE_ID_SCHEMAS[definition.aggregateType].safeParse(event.aggregateId).success) {
      context.addIssue({
        code: "custom",
        path: ["aggregateId"],
        message: "aggregate identifier mismatch",
      });
    }
  });

export type DomainEvent = z.infer<typeof DomainEventSchema>;
type EventAggregateIds = {
  "jar.created": z.infer<typeof JarIdSchema>;
  "jar.closed": z.infer<typeof JarIdSchema>;
  "invite.issued": InviteVersionId;
  "invite.superseded": InviteVersionId;
  "membership.joined": MembershipTenureId;
  "membership.left": MembershipTenureId;
  "slip.logged": SlipId;
  "jar.milestone_crossed": JarMilestoneId;
  "report.created": z.infer<typeof ReportIdSchema>;
  "report.owned": z.infer<typeof ReportIdSchema>;
  "report.denied": z.infer<typeof ReportIdSchema>;
  "report.expired": z.infer<typeof ReportIdSchema>;
  "report.jar_closed": z.infer<typeof ReportIdSchema>;
  "report.member_departed": z.infer<typeof ReportIdSchema>;
  "rescue.started": RescueInterventionId;
  "rescue.extended": RescueInterventionId;
  "rescue.safe": RescueInterventionId;
  "rescue.slipped": RescueInterventionId;
  "rescue.check_in_due": RescueInterventionId;
  "rescue.abandoned": RescueInterventionId;
  "streak.milestone_reached": StreakAchievementId;
  "recap.created": RecapId;
  "notification.requested": NotificationId;
  "account.deletion_requested": AccountDeletionId;
};

export type NewDomainEvent = {
  [Type in DomainEventType]: Readonly<{
    type: Type;
    aggregateId: EventAggregateIds[Type];
    aggregateVersion: number;
  }>;
}[DomainEventType];
