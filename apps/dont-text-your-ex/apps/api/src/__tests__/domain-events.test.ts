import { describe, expect, it } from "vitest";
import { ReportIdSchema } from "../../../../contracts";
import { DomainEventSchema, domainEventDefinition, type NewDomainEvent } from "../domain-events";

describe("domain event contract", () => {
  it("maps every supported event to its aggregate without a private payload", () => {
    const input: NewDomainEvent = {
      type: "report.created",
      aggregateId: ReportIdSchema.parse("rpt_example"),
      aggregateVersion: 1,
    };

    expect(domainEventDefinition(input.type)).toEqual({
      aggregateType: "report",
      schemaVersion: 1,
    });
    expect(input).not.toHaveProperty("payload");
  });

  it("rejects unknown event types and mismatched aggregates at the persistence boundary", () => {
    expect(
      DomainEventSchema.safeParse({
        id: "evt_example",
        type: "report.created",
        schemaVersion: 1,
        aggregateType: "jar",
        aggregateId: "rpt_example",
        aggregateVersion: 1,
        occurredAt: 1,
      }).success,
    ).toBe(false);
    expect(
      DomainEventSchema.safeParse({
        id: "evt_0123456789abcdef0123456789abcdef",
        type: "report.created",
        schemaVersion: 1,
        aggregateType: "report",
        aggregateId: "jar_not_a_report",
        aggregateVersion: 1,
        occurredAt: 1,
      }).success,
    ).toBe(false);
    expect(
      DomainEventSchema.safeParse({
        id: "evt_example",
        type: "unknown.created",
        schemaVersion: 1,
        aggregateType: "unknown",
        aggregateId: "unknown_example",
        aggregateVersion: 1,
        occurredAt: 1,
      }).success,
    ).toBe(false);
  });
});
