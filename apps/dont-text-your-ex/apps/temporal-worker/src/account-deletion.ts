import type { Client, WorkflowExecutionStatusName } from "@temporalio/client";
import type { AccountDeletionId } from "../../../contracts";
import type { PostgresAccountDeletionStore } from "../../api/src/account-deletion";
import type { AccountDeletionWorkflowFence } from "./workflow-dispatch-fence";

export interface AppleRevocationGateway {
  exchangeAuthorizationCode(authorizationCode: string): Promise<{ refreshToken: string }>;
  revokeRefreshToken(refreshToken: string): Promise<void>;
}

export interface AccountDeletionWorkflowCleanupGateway {
  terminate(workflowId: string): Promise<void>;
  deleteHistory(workflowId: string): Promise<void>;
}

function workflowAlreadyAbsent(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "WorkflowNotFoundError") ||
    (typeof error === "object" && error !== null && "code" in error && error.code === 5)
  );
}

const CLOSED_WORKFLOW_STATUSES: ReadonlySet<WorkflowExecutionStatusName> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TERMINATED",
  "CONTINUED_AS_NEW",
  "TIMED_OUT",
]);

export class TemporalAccountDeletionWorkflowCleanupGateway
  implements AccountDeletionWorkflowCleanupGateway
{
  constructor(private readonly client: Client) {}

  async terminate(workflowId: string): Promise<void> {
    const handle = this.client.workflow.getHandle(workflowId);
    try {
      await handle.terminate("account deletion");
    } catch (error) {
      if (workflowAlreadyAbsent(error)) return;
      try {
        const execution = await handle.describe();
        if (CLOSED_WORKFLOW_STATUSES.has(execution.status.name)) return;
      } catch (descriptionError) {
        if (workflowAlreadyAbsent(descriptionError)) return;
        throw descriptionError;
      }
      throw error;
    }
  }

  async deleteHistory(workflowId: string): Promise<void> {
    try {
      await this.client.workflowService.deleteWorkflowExecution({
        namespace: this.client.workflow.options.namespace,
        workflowExecution: { workflowId },
      });
    } catch (error) {
      if (!workflowAlreadyAbsent(error)) throw error;
    }
  }
}

export type AccountDeletionActivityStore = Pick<
  PostgresAccountDeletionStore,
  | "eraseLocally"
  | "loadAuthorizationCode"
  | "loadRefreshToken"
  | "saveRefreshToken"
  | "markTerminal"
  | "listAssociatedWorkflowIds"
  | "markCleanupState"
  | "listTerminalDeletionWorkflows"
  | "purgeExpiredRecords"
>;

export type AccountDeletionActivities = ReturnType<typeof createAccountDeletionActivities>;

export function createAccountDeletionActivities(dependencies: {
  readonly store: AccountDeletionActivityStore;
  readonly apple: AppleRevocationGateway;
  readonly workflows: AccountDeletionWorkflowCleanupGateway;
  readonly observeErasureStuck: () => void;
  readonly workflowFence: AccountDeletionWorkflowFence;
}) {
  return {
    async recordAccountDeletionErasureStuck(_input: {
      readonly deletionRequestId: AccountDeletionId;
    }) {
      dependencies.observeErasureStuck();
      return { recorded: true as const };
    },
    async terminateAssociatedWorkflows(input: { readonly deletionRequestId: AccountDeletionId }) {
      const workflowIds = await dependencies.store.listAssociatedWorkflowIds(
        input.deletionRequestId,
        ["pending"],
      );
      for (const workflowId of workflowIds) {
        await dependencies.workflowFence.withCleanupFence(workflowId, async () => {
          await dependencies.workflows.terminate(workflowId);
          await dependencies.store.markCleanupState(
            input.deletionRequestId,
            workflowId,
            "terminated",
          );
        });
      }
      return { terminated: workflowIds.length };
    },

    async eraseAccountLocally(input: { readonly deletionRequestId: AccountDeletionId }) {
      await dependencies.store.eraseLocally(input.deletionRequestId);
      return { erased: true as const };
    },

    async revokeAppleCredential(input: { readonly deletionRequestId: AccountDeletionId }) {
      let refreshToken = await dependencies.store.loadRefreshToken(input.deletionRequestId);
      if (!refreshToken) {
        const authorizationCode = await dependencies.store.loadAuthorizationCode(
          input.deletionRequestId,
        );
        if (!authorizationCode) return { outcome: "manual_action_required" as const };
        const exchanged = await dependencies.apple.exchangeAuthorizationCode(authorizationCode);
        refreshToken = exchanged.refreshToken;
        await dependencies.store.saveRefreshToken(input.deletionRequestId, refreshToken);
      }
      await dependencies.apple.revokeRefreshToken(refreshToken);
      return { outcome: "revoked" as const };
    },

    async finishAccountDeletion(input: {
      readonly deletionRequestId: AccountDeletionId;
      readonly state: "complete" | "manual_action_required";
    }) {
      await dependencies.store.markTerminal(input.deletionRequestId, input.state);
      return { state: input.state };
    },

    async deleteAssociatedWorkflowHistories(input: {
      readonly deletionRequestId: AccountDeletionId;
    }) {
      const workflowIds = await dependencies.store.listAssociatedWorkflowIds(
        input.deletionRequestId,
        ["pending", "terminated"],
      );
      for (const workflowId of workflowIds) {
        await dependencies.workflowFence.withCleanupFence(workflowId, async () => {
          await dependencies.workflows.deleteHistory(workflowId);
          await dependencies.store.markCleanupState(input.deletionRequestId, workflowId, "deleted");
        });
      }
      return { deleted: workflowIds.length };
    },

    async sweepAccountDeletionHistories(input: {
      readonly terminalBefore: number;
      readonly limit: number;
    }) {
      const items = await dependencies.store.listTerminalDeletionWorkflows(
        input.terminalBefore,
        input.limit,
      );
      for (const item of items) {
        await dependencies.workflowFence.withCleanupFence(item.workflowId, async () => {
          await dependencies.workflows.deleteHistory(item.workflowId);
          await dependencies.store.markCleanupState(
            item.deletionRequestId,
            item.workflowId,
            "deleted",
          );
        });
      }
      return { deleted: items.length };
    },

    async purgeExpiredAccountDeletionRecords(input: {
      readonly expiredBefore: number;
      readonly limit: number;
    }) {
      return dependencies.store.purgeExpiredRecords(input.expiredBefore, input.limit);
    },
  };
}
