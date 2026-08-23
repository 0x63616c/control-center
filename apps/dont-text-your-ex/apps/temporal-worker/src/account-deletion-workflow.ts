import { defineQuery, proxyActivities, setHandler } from "@temporalio/workflow";
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
  Pick<AccountDeletionActivities, "eraseAccountLocally" | "finishAccountDeletion">
>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 20,
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

  await localActivities.eraseAccountLocally({ deletionRequestId: input.deletionRequestId });
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
  state = terminal;
  return terminal;
}
