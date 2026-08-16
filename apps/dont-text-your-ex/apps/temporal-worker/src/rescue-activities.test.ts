import { describe, expect, it, vi } from "vitest";
import { RescueInterventionIdSchema, RescueInterventionSchema } from "../../../contracts";
import { createRescueActivities } from "./rescue-activities";

const intervention = RescueInterventionSchema.parse({
  id: "rsi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  status: "active",
  startedAt: 1_000,
  deadlineAt: 601_000,
  extensionCount: 0,
  aggregateVersion: 1,
  updatedAt: 1_000,
});

describe("rescue activities", () => {
  it("reloads and conditionally advances only by opaque intervention id and version", async () => {
    const load = vi.fn(async () => intervention);
    const advanceAtDeadline = vi.fn(async () => intervention);
    const eraseForAccountDeletion = vi.fn(async () => undefined);
    const activities = createRescueActivities({
      store: { load, advanceAtDeadline, eraseForAccountDeletion } as never,
    });

    await expect(activities.loadRescue({ interventionId: intervention.id })).resolves.toEqual(
      intervention,
    );
    await expect(
      activities.advanceRescueAtDeadline({
        interventionId: intervention.id,
        expectedAggregateVersion: 1,
      }),
    ).resolves.toEqual(intervention);
    expect(advanceAtDeadline).toHaveBeenCalledWith({
      interventionId: intervention.id,
      expectedAggregateVersion: 1,
    });
  });

  it("erases by an opaque intervention id without returning account data", async () => {
    const eraseForAccountDeletion = vi.fn(async () => undefined);
    const activities = createRescueActivities({
      store: {
        load: vi.fn(),
        advanceAtDeadline: vi.fn(),
        eraseForAccountDeletion,
      } as never,
    });
    const interventionId = RescueInterventionIdSchema.parse("rsi_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    await expect(activities.eraseRescueForAccountDeletion({ interventionId })).resolves.toEqual({
      erased: true,
    });
    expect(eraseForAccountDeletion).toHaveBeenCalledWith(interventionId);
  });
});
