import { condition, defineQuery, proxyActivities, setHandler } from "@temporalio/workflow";
import {
  type AccountDeletionWorkflowInput,
  AccountDeletionWorkflowInputSchema,
} from "../../../contracts";
import type { AccountDeletionActivities } from "./account-deletion";

const ACCOUNT_DELETION_WORKFLOW_STATE = {
  Erasing: "erasing",
  RevokingApple: "revoking_apple",
  Complete: "complete",
  ManualActionRequired: "manual_action_required",
} as const;
export type AccountDeletionWorkflowState =
  (typeof ACCOUNT_DELETION_WORKFLOW_STATE)[keyof typeof ACCOUNT_DELETION_WORKFLOW_STATE];
type TerminalAccountDeletionWorkflowState =
  | typeof ACCOUNT_DELETION_WORKFLOW_STATE.Complete
  | typeof ACCOUNT_DELETION_WORKFLOW_STATE.ManualActionRequired;

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
): Promise<TerminalAccountDeletionWorkflowState> {
  const input = AccountDeletionWorkflowInputSchema.parse(rawInput);
  let state: AccountDeletionWorkflowState = ACCOUNT_DELETION_WORKFLOW_STATE.Erasing;
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
  state = ACCOUNT_DELETION_WORKFLOW_STATE.RevokingApple;
  let terminal: TerminalAccountDeletionWorkflowState;
  try {
    const result = await appleActivities.revokeAppleCredential({
      deletionRequestId: input.deletionRequestId,
    });
    terminal =
      result.outcome === "revoked"
        ? ACCOUNT_DELETION_WORKFLOW_STATE.Complete
        : ACCOUNT_DELETION_WORKFLOW_STATE.ManualActionRequired;
  } catch {
    terminal = ACCOUNT_DELETION_WORKFLOW_STATE.ManualActionRequired;
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
