import type { Client, WorkflowExecutionStatusName } from "@temporalio/client";
import type { AccountDeletionId } from "../../../contracts";
import {
  ACCOUNT_DELETION_CLEANUP_STATE,
  ACCOUNT_DELETION_STATE,
  type PostgresAccountDeletionStore,
  type TerminalAccountDeletionState,
} from "../../api/src/account-deletion";
import type { AccountDeletionWorkflowFence } from "./workflow-dispatch-fence";

export interface AppleRevocationGateway {
  exchangeAuthorizationCode(
    authorizationCode: string,
    expectedSubject: string,
  ): Promise<{ refreshToken: string }>;
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
  | "loadAppleRevocationCredential"
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
        [ACCOUNT_DELETION_CLEANUP_STATE.Pending],
      );
      for (const workflowId of workflowIds) {
        await dependencies.workflowFence.withCleanupFence(workflowId, async () => {
          await dependencies.workflows.terminate(workflowId);
          await dependencies.store.markCleanupState(
            input.deletionRequestId,
            workflowId,
            ACCOUNT_DELETION_CLEANUP_STATE.Terminated,
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
        const credential = await dependencies.store.loadAppleRevocationCredential(
          input.deletionRequestId,
        );
        if (!credential) {
          return { outcome: ACCOUNT_DELETION_STATE.ManualActionRequired };
        }
        const exchanged = await dependencies.apple.exchangeAuthorizationCode(
          credential.authorizationCode,
          credential.expectedSubject,
        );
        refreshToken = exchanged.refreshToken;
        await dependencies.store.saveRefreshToken(input.deletionRequestId, refreshToken);
      }
      await dependencies.apple.revokeRefreshToken(refreshToken);
      return { outcome: "revoked" as const };
    },

    async finishAccountDeletion(input: {
      readonly deletionRequestId: AccountDeletionId;
      readonly state: TerminalAccountDeletionState;
    }) {
      await dependencies.store.markTerminal(input.deletionRequestId, input.state);
      return { state: input.state };
    },

    async deleteAssociatedWorkflowHistories(input: {
      readonly deletionRequestId: AccountDeletionId;
    }) {
      const workflowIds = await dependencies.store.listAssociatedWorkflowIds(
        input.deletionRequestId,
        [ACCOUNT_DELETION_CLEANUP_STATE.Pending, ACCOUNT_DELETION_CLEANUP_STATE.Terminated],
      );
      for (const workflowId of workflowIds) {
        await dependencies.workflowFence.withCleanupFence(workflowId, async () => {
          await dependencies.workflows.deleteHistory(workflowId);
          await dependencies.store.markCleanupState(
            input.deletionRequestId,
            workflowId,
            ACCOUNT_DELETION_CLEANUP_STATE.Deleted,
          );
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
            ACCOUNT_DELETION_CLEANUP_STATE.Deleted,
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
