import { condition, defineQuery, proxyActivities, setHandler } from "@temporalio/workflow";
import {
  type AccountDeletionWorkflowInput,
  AccountDeletionWorkflowInputSchema,
} from "../../../contracts";
import type { AccountDeletionActivities } from "./account-deletion";

export type AccountDeletionWorkflowState =
  | "erasing"
  | "revoking_apple"
  | "complete"
  | "manual_action_required";

export const accountDeletionStateQuery =
  defineQuery<AccountDeletionWorkflowState>("accountDeletionState");

const localActivities = proxyActivities<
  Pick<
    AccountDeletionActivities,
    "eraseAccountLocally" | "finishAccountDeletion" | "recordAccountDeletionErasureStuck"
  >
>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
  },
});

const cleanupActivities = proxyActivities<
  Pick<
    AccountDeletionActivities,
    "terminateAssociatedWorkflows" | "deleteAssociatedWorkflowHistories"
  >
>({
  startToCloseTimeout: "2 minutes",
  scheduleToCloseTimeout: "24 hours",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "15 minutes",
  },
});

const appleActivities = proxyActivities<Pick<AccountDeletionActivities, "revokeAppleCredential">>({
  startToCloseTimeout: "30 seconds",
  scheduleToCloseTimeout: "24 hours",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "15 minutes",
    nonRetryableErrorTypes: ["AppleRevocationPermanentError"],
  },
});

export async function AccountDeletionWorkflow(
  rawInput: AccountDeletionWorkflowInput,
): Promise<"complete" | "manual_action_required"> {
  const input = AccountDeletionWorkflowInputSchema.parse(rawInput);
  let state: AccountDeletionWorkflowState = "erasing";
  setHandler(accountDeletionStateQuery, () => state);

  await cleanupActivities.terminateAssociatedWorkflows({
    deletionRequestId: input.deletionRequestId,
  });
  let locallyErased = false;
  const localErasure = localActivities
    .eraseAccountLocally({ deletionRequestId: input.deletionRequestId })
    .then((result) => {
      locallyErased = true;
      return result;
    });
  const completedInsideTarget = await condition(() => locallyErased, "15 minutes");
  if (!completedInsideTarget) {
    await localActivities.recordAccountDeletionErasureStuck({
      deletionRequestId: input.deletionRequestId,
    });
  }
  await localErasure;
  await cleanupActivities.terminateAssociatedWorkflows({
    deletionRequestId: input.deletionRequestId,
  });
  state = "revoking_apple";
  let terminal: "complete" | "manual_action_required";
  try {
    const result = await appleActivities.revokeAppleCredential({
      deletionRequestId: input.deletionRequestId,
    });
    terminal = result.outcome === "revoked" ? "complete" : "manual_action_required";
  } catch {
    terminal = "manual_action_required";
  }
  await localActivities.finishAccountDeletion({
    deletionRequestId: input.deletionRequestId,
    state: terminal,
  });
  await cleanupActivities.deleteAssociatedWorkflowHistories({
    deletionRequestId: input.deletionRequestId,
  });
  state = terminal;
  return terminal;
}
