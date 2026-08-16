import { z } from "zod";

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

const EventIdSchema = z
  .string()
  .regex(/^evt_[A-Za-z0-9]+$/)
  .brand<"EventId">();

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
  });

export type DomainEvent = z.infer<typeof DomainEventSchema>;
export type NewDomainEvent = Readonly<{
  type: DomainEventType;
  aggregateId: string;
  aggregateVersion: number;
}>;
