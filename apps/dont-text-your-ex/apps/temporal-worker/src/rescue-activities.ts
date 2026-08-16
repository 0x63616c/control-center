import type { RescueInterventionId } from "../../../contracts";
import type { RescueStore } from "../../api/src/rescue-store";

export interface RescueActivities {
  loadRescue(input: {
    readonly interventionId: RescueInterventionId;
  }): ReturnType<RescueStore["load"]>;
  advanceRescueAtDeadline(input: {
    readonly interventionId: RescueInterventionId;
    readonly expectedAggregateVersion: number;
  }): ReturnType<RescueStore["advanceAtDeadline"]>;
  eraseRescueForAccountDeletion(input: {
    readonly interventionId: RescueInterventionId;
  }): Promise<{ readonly erased: true }>;
}

export function createRescueActivities(dependencies: {
  readonly store: Pick<RescueStore, "load" | "advanceAtDeadline" | "eraseForAccountDeletion">;
}): RescueActivities {
  return {
    loadRescue: ({ interventionId }) => dependencies.store.load(interventionId),
    advanceRescueAtDeadline: (input) => dependencies.store.advanceAtDeadline(input),
    async eraseRescueForAccountDeletion({ interventionId }) {
      await dependencies.store.eraseForAccountDeletion(interventionId);
      return { erased: true };
    },
  };
}
